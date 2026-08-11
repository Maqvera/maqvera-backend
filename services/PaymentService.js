import PaymentModel from "../models/PaymentModel.js";
import BookingHeaderModel from "../models/BookingHeaderModel.js";
import VisaCaseModel from "../models/VisaCaseModel.js";
import TravelPlanModel from "../models/TravelPlanModel.js";
import FinanceSequenceModel from "../models/FinanceSequenceModel.js";
import AuditLogModel from "../models/AuditLogmodel.js";
import { publishEvent } from "../utils/eventBus.js";
import { getFinanceConfig } from "../utils/financeConfig.js";
import { getGatewayAdapter } from "./gateways/index.js";

const roundCurrency = (value) => Math.round((Number(value) || 0) * 100) / 100;

// ---------------------------------------------------------------------------
// Pure helpers — no DB access, unit-testable directly (see
// tests/paymentService.test.js).
// ---------------------------------------------------------------------------

// Methods that settle without an external API call — everything else
// defaults to the tenant's configured default gateway (itself "Manual"
// unless explicitly changed), never auto-routed to a live gateway like
// Stripe without the caller asking for it.
const MANUAL_ONLY_METHODS = new Set(["Cash", "Cheque", "Bank Transfer"]);

/** Resolves which gateway processes a payment when the caller doesn't say. */
export const resolveGateway = (paymentMethod, requestedGateway, defaultGateway) => {
  if (requestedGateway) return requestedGateway;
  if (MANUAL_ONLY_METHODS.has(paymentMethod)) return "Manual";
  return defaultGateway;
};

/**
 * Rule-based (not AI) fraud signal — "Duplicate Payment, Velocity Check,
 * Amount Threshold." Pure: takes pre-computed counts, does no DB work
 * itself (see PaymentService._runFraudCheck for the DB-backed wrapper).
 */
export const computeFraudRiskScore = ({ isDuplicate, velocityCount, velocityMax, amount, amountThreshold }) => {
  const flags = [];
  let riskScore = 0;
  if (isDuplicate) { flags.push("DuplicatePayment"); riskScore += 40; }
  if (velocityCount > velocityMax) { flags.push("VelocityExceeded"); riskScore += 30; }
  if (amount >= amountThreshold) { flags.push("AmountThresholdExceeded"); riskScore += 30; }
  return { riskScore: Math.min(riskScore, 100), flags };
};

/** Statuses a payment must be in to accept a new allocation. */
export const isPaymentAllocatable = (status) => ["Captured", "Allocated"].includes(status);

/** Statuses a payment must be in to be voided (i.e. before any funds were put to use). */
export const isPaymentVoidable = (status) => ["Initiated", "Pending", "Authorized", "Captured"].includes(status);

/** Statuses a payment must be in to accept a (partial, unallocated-portion-only) refund. */
export const isPaymentRefundable = (status) => ["Captured", "Allocated", "Settled", "Completed"].includes(status);

/** Statuses a payment must be in for its Settlement Engine settlement to actually complete (Finance Module Part 23). */
export const isPaymentSettleable = (status) => ["Captured", "Allocated"].includes(status);

// Real target-type validation only for modules that actually exist in this
// codebase — see utils/financeConfig.js allocationTargetTypes doc comment.
const REAL_ALLOCATION_TARGET_MODELS = { Booking: BookingHeaderModel, Visa: VisaCaseModel, Travel: TravelPlanModel };

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

class PaymentService {
  static async _generatePaymentNumber(tenantId) {
    const config = getFinanceConfig();
    const year = `${new Date().getUTCFullYear()}`;
    const seq = await FinanceSequenceModel.getNext(tenantId, "paymentNumber", year);
    return `${config.paymentNumberPrefix}-${year}-${String(seq).padStart(6, "0")}`;
  }

  /** DB-backed wrapper around computeFraudRiskScore — gathers the real counts. */
  static async _runFraudCheck({ tenantId, amount, currency, paymentMethod, reference }) {
    const config = getFinanceConfig();
    const now = Date.now();

    const duplicateSince = new Date(now - config.fraudDuplicateWindowMinutes * 60 * 1000);
    const isDuplicate = reference
      ? !!(await PaymentModel.findOne({ tenantId, amount, currency, paymentMethod, reference, createdAt: { $gte: duplicateSince } }).lean())
      : false;

    const velocitySince = new Date(now - config.fraudVelocityWindowMinutes * 60 * 1000);
    const velocityCount = reference
      ? await PaymentModel.countDocuments({ tenantId, reference, createdAt: { $gte: velocitySince } })
      : 0;

    return computeFraudRiskScore({ isDuplicate, velocityCount, velocityMax: config.fraudVelocityMaxCount, amount, amountThreshold: config.fraudAmountThreshold });
  }

  /**
   * POST /api/v1/payments
   * Validate Request -> Fraud Check -> Gateway Processing -> Payment
   * Created -> Timeline -> Audit -> Publish PaymentCreated.
   */
  static async createPayment(data, tenantId, userId) {
    const config = getFinanceConfig();
    const { paymentType = config.defaultPaymentType, partyType = null, partyId = null, bankAccountId = null, amount, currency, paymentMethod, gateway: requestedGateway, reference = null, transactionDate } = data;

    if (!amount || amount <= 0 || !currency || !paymentMethod) {
      throw new Error("amount, currency, and paymentMethod are required.");
    }

    const gateway = resolveGateway(paymentMethod, requestedGateway, config.defaultGateway);
    const adapter = getGatewayAdapter(gateway);
    if (!adapter) {
      throw new Error(`Payment gateway "${gateway}" is not yet supported — no adapter is implemented for it (services/gateways/).`);
    }

    const roundedAmount = roundCurrency(amount);
    const fraudCheck = await PaymentService._runFraudCheck({ tenantId, amount: roundedAmount, currency, paymentMethod, reference });
    const paymentNumber = await PaymentService._generatePaymentNumber(tenantId);

    const payment = await PaymentModel.create({
      tenantId,
      paymentNumber,
      paymentType,
      partyType,
      partyId,
      bankAccountId,
      amount: roundedAmount,
      currency,
      paymentMethod,
      gateway,
      status: config.defaultPaymentStatus,
      reference,
      transactionDate: transactionDate ? new Date(transactionDate) : new Date(),
      unallocatedAmount: roundedAmount,
      fraudCheck: { riskScore: fraudCheck.riskScore, flags: fraudCheck.flags, checkedAt: new Date() },
      timeline: [{ event: "PaymentCreated", description: `Payment of ${roundedAmount} ${currency} initiated via ${paymentMethod} (${gateway}).`, performedBy: userId || null }],
      createdBy: userId || null
    });

    publishEvent("PaymentCreated", { tenantId, paymentId: payment._id.toString(), paymentNumber, amount: roundedAmount, currency, riskScore: fraudCheck.riskScore, performedBy: userId || null });

    // Gateway Processing — authorize then capture. Real adapter calls only;
    // Manual settles instantly with no external round trip.
    const authResult = await adapter.authorize({ amount: roundedAmount, currency, reference, paymentMethodId: data.gatewayPaymentMethodId });
    payment.gatewayDetails.transactionId = authResult.transactionId || null;
    payment.gatewayDetails.rawResponse = authResult.rawResponse || null;

    if (authResult.status !== "Authorized") {
      payment.status = "Failed";
      payment.failureReason = authResult.failureReason || "Gateway authorization failed.";
      payment.timeline.push({ event: "PaymentFailed", description: payment.failureReason, performedBy: userId || null });
      await payment.save();
      publishEvent("PaymentFailed", { tenantId, paymentId: payment._id.toString(), reason: payment.failureReason, performedBy: userId || null });
      return payment.toJSON();
    }

    payment.status = "Authorized";
    payment.gatewayDetails.authorizedAt = new Date();
    payment.timeline.push({ event: "PaymentAuthorized", description: "Payment authorized.", performedBy: userId || null });
    publishEvent("PaymentAuthorized", { tenantId, paymentId: payment._id.toString(), performedBy: userId || null });

    const captureResult = await adapter.capture({ amount: roundedAmount, currency, gatewayDetails: payment.gatewayDetails });
    payment.gatewayDetails.transactionId = captureResult.transactionId || payment.gatewayDetails.transactionId;
    payment.gatewayDetails.rawResponse = captureResult.rawResponse || payment.gatewayDetails.rawResponse;

    if (captureResult.status !== "Captured") {
      payment.status = "Failed";
      payment.failureReason = captureResult.failureReason || "Gateway capture failed.";
      payment.timeline.push({ event: "PaymentFailed", description: payment.failureReason, performedBy: userId || null });
      await payment.save();
      publishEvent("PaymentFailed", { tenantId, paymentId: payment._id.toString(), reason: payment.failureReason, performedBy: userId || null });
      return payment.toJSON();
    }

    payment.status = "Captured";
    payment.gatewayDetails.capturedAt = new Date();
    payment.timeline.push({ event: "PaymentCaptured", description: "Payment captured.", performedBy: userId || null });
    await payment.save();

    await AuditLogModel.create({
      action: "finance.payment.create",
      module: "Finance",
      resource: "Payment",
      resourceId: payment._id.toString(),
      userId: userId || null,
      tenantId,
      details: { paymentNumber, amount: roundedAmount, currency, gateway, riskScore: fraudCheck.riskScore }
    });

    publishEvent("PaymentCaptured", { tenantId, paymentId: payment._id.toString(), bankAccountId: payment.bankAccountId ? payment.bankAccountId.toString() : null, performedBy: userId || null });

    return payment.toJSON();
  }

  /**
   * GET /api/v1/payments
   */
  static async listPayments(query, tenantId) {
    const { status, paymentType, currency, paymentMethod, gateway, partyId } = query;
    const filter = { tenantId };
    if (status) filter.status = status;
    if (paymentType) filter.paymentType = paymentType;
    if (currency) filter.currency = currency;
    if (paymentMethod) filter.paymentMethod = paymentMethod;
    if (gateway) filter.gateway = gateway;
    if (partyId) filter.partyId = partyId;
    if (query.dateFrom || query.dateTo) {
      filter.transactionDate = {};
      if (query.dateFrom) filter.transactionDate.$gte = new Date(query.dateFrom);
      if (query.dateTo) filter.transactionDate.$lte = new Date(query.dateTo);
    }

    const page = Math.max(parseInt(query.page, 10) || 1, 1);
    const pageSize = Math.min(Math.max(parseInt(query.pageSize, 10) || 20, 1), 100);
    const skip = (page - 1) * pageSize;

    let sortSpec = { transactionDate: -1 };
    if (query.sort) {
      const direction = query.sort.startsWith("-") ? -1 : 1;
      const field = query.sort.replace(/^-/, "");
      sortSpec = { [field]: direction };
    }

    const [items, total] = await Promise.all([
      PaymentModel.find(filter).sort(sortSpec).skip(skip).limit(pageSize).lean(),
      PaymentModel.countDocuments(filter)
    ]);

    return { items, pagination: { total, page, pageSize, totalPages: Math.ceil(total / pageSize) } };
  }

  static async getPaymentById(paymentId, tenantId) {
    const payment = await PaymentModel.findOne({ _id: paymentId, tenantId });
    if (!payment) throw new Error("Payment not found.");
    return payment;
  }

  /**
   * Consumes `amount` of a payment's unallocated balance. Kept as the one
   * shared choke point every allocation path goes through — AR's own
   * allocate-payment, AP's own, and this module's generic `allocate` all
   * call it, which is what makes `payment.allocations[]` a complete,
   * trustworthy audit trail no matter which "specialized workflow"
   * triggered it (see this file's own top-of-file architecture note).
   */
  static async consumeUnallocatedAmount(paymentId, tenantId, amount, allocationMeta = {}) {
    const payment = await PaymentService.getPaymentById(paymentId, tenantId);
    const roundedAmount = roundCurrency(amount);

    if (roundedAmount > payment.unallocatedAmount) {
      throw new Error(`Payment ${paymentId} does not have enough unallocated balance: requested ${roundedAmount}, available ${payment.unallocatedAmount}.`);
    }

    payment.unallocatedAmount = roundCurrency(payment.unallocatedAmount - roundedAmount);
    if (allocationMeta.targetType && allocationMeta.targetId) {
      payment.allocations.push({ targetType: allocationMeta.targetType, targetId: allocationMeta.targetId, amount: roundedAmount, allocatedBy: allocationMeta.allocatedBy || null });
    }
    if (payment.unallocatedAmount === 0 && payment.status === "Captured") {
      payment.status = "Allocated";
    }
    payment.timeline.push({ event: "PaymentAllocated", description: `${roundedAmount} ${payment.currency} allocated${allocationMeta.targetType ? ` to ${allocationMeta.targetType}` : ""}.`, performedBy: allocationMeta.allocatedBy || null });
    await payment.save();

    return payment.toJSON();
  }

  /**
   * POST /api/v1/payments/{paymentId}/allocate — the generic multi-target
   * Allocation Engine. AR/AP's own allocate-payment endpoints remain the
   * "specialized workflow" entry points (they still exist, unchanged in
   * shape) and both ultimately funnel through consumeUnallocatedAmount
   * above; this endpoint is the direct, general-purpose path for targets
   * that don't have their own dedicated module endpoint (Booking, Visa,
   * Travel) or for a caller that already knows it wants generic behavior.
   */
  static async allocate(paymentId, data, tenantId, userId) {
    const config = getFinanceConfig();
    const { targetType, targetId, amount } = data;
    if (!targetType || !targetId || !amount || amount <= 0) {
      throw new Error("targetType, targetId, and a positive amount are required.");
    }
    if (!config.allocationTargetTypes.includes(targetType)) {
      throw new Error(`Invalid targetType "${targetType}".`);
    }

    // AccountsReceivable/AccountsPayable have their own richer, fully-owned
    // workflows (ledger journal, overpayment -> credit, status lifecycle) —
    // delegate entirely rather than reimplementing that logic here. Lazy
    // dynamic import avoids a top-level circular dependency (both of those
    // services already import PaymentService for consumeUnallocatedAmount).
    if (targetType === "AccountsReceivable") {
      const { default: AccountsReceivableService } = await import("./AccountsReceivableService.js");
      return AccountsReceivableService.allocatePayment(targetId, { paymentId, amount }, tenantId, userId);
    }
    if (targetType === "AccountsPayable") {
      const { default: AccountsPayableService } = await import("./AccountsPayableService.js");
      return AccountsPayableService.allocatePayment(targetId, { paymentId, amount }, tenantId, userId);
    }

    const payment = await PaymentService.getPaymentById(paymentId, tenantId);
    if (!isPaymentAllocatable(payment.status)) {
      throw new Error(`Payment cannot be allocated from status "${payment.status}".`);
    }

    const TargetModel = REAL_ALLOCATION_TARGET_MODELS[targetType];
    if (!TargetModel) {
      throw new Error(`Allocation target type "${targetType}" is not yet supported — no ${targetType} module exists in this codebase yet.`);
    }
    const target = await TargetModel.findOne({ _id: targetId, tenantId }).lean();
    if (!target) throw new Error(`${targetType} not found.`);

    const updated = await PaymentService.consumeUnallocatedAmount(paymentId, tenantId, amount, { targetType, targetId, allocatedBy: userId });

    await AuditLogModel.create({
      action: "finance.payment.allocate",
      module: "Finance",
      resource: "Payment",
      resourceId: paymentId.toString(),
      userId: userId || null,
      tenantId,
      details: { targetType, targetId: targetId.toString(), amount: roundCurrency(amount) }
    });

    publishEvent("PaymentAllocated", { tenantId, paymentId: paymentId.toString(), targetType, targetId: targetId.toString(), amount: roundCurrency(amount), performedBy: userId || null });

    return updated;
  }

  /**
   * POST /api/v1/payments/{paymentId}/void — reverses a payment before any
   * of it was put to use (never yet allocated).
   */
  static async void(paymentId, data, tenantId, userId) {
    const payment = await PaymentService.getPaymentById(paymentId, tenantId);
    if (!isPaymentVoidable(payment.status)) {
      throw new Error(`Payment cannot be voided from status "${payment.status}".`);
    }

    const adapter = getGatewayAdapter(payment.gateway);
    if (adapter) {
      const result = await adapter.void({ gatewayDetails: payment.gatewayDetails });
      if (result.status !== "Voided") {
        throw new Error(result.failureReason || "Gateway void failed.");
      }
    }

    payment.status = "Voided";
    payment.voidedAt = new Date();
    payment.voidedBy = userId || null;
    payment.timeline.push({ event: "PaymentVoided", description: data?.reason || "Payment voided.", performedBy: userId || null });
    await payment.save();

    await AuditLogModel.create({ action: "finance.payment.void", module: "Finance", resource: "Payment", resourceId: paymentId.toString(), userId: userId || null, tenantId, details: { reason: data?.reason || null } });
    publishEvent("PaymentReversed", { tenantId, paymentId: paymentId.toString(), reversalType: "Void", performedBy: userId || null });

    return payment.toJSON();
  }

  /**
   * POST /api/v1/payments/{paymentId}/refund — refunds up to the
   * currently-*unallocated* portion only. Refunding an already-allocated
   * portion would require cascading the reversal into whatever it was
   * allocated to (AR/AP/Booking/...); that's a deliberately deferred
   * scope boundary (see the Part 7 doc) — use that target's own reversal
   * mechanism (e.g. Journal reversal) for money already put to use.
   */
  static async refund(paymentId, data, tenantId, userId) {
    const { amount, reason = null } = data;
    if (!amount || amount <= 0) throw new Error("A positive refund amount is required.");

    const payment = await PaymentService.getPaymentById(paymentId, tenantId);
    if (!isPaymentRefundable(payment.status)) {
      throw new Error(`Payment cannot be refunded from status "${payment.status}".`);
    }
    const roundedAmount = roundCurrency(amount);
    if (roundedAmount > payment.unallocatedAmount) {
      throw new Error(`Refund amount exceeds the unallocated portion available (${payment.unallocatedAmount}). Already-allocated funds must be reversed via their own target's mechanism.`);
    }

    const adapter = getGatewayAdapter(payment.gateway);
    if (adapter) {
      const result = await adapter.refund({ amount: roundedAmount, gatewayDetails: payment.gatewayDetails });
      if (result.status !== "Refunded") {
        throw new Error(result.failureReason || "Gateway refund failed.");
      }
    }

    payment.unallocatedAmount = roundCurrency(payment.unallocatedAmount - roundedAmount);
    payment.refundedAmount = roundCurrency(payment.refundedAmount + roundedAmount);
    if (payment.unallocatedAmount === 0 && payment.refundedAmount === payment.amount) {
      payment.status = "Refunded";
    }
    payment.timeline.push({ event: "PaymentRefunded", description: `${roundedAmount} ${payment.currency} refunded${reason ? `: ${reason}` : ""}.`, performedBy: userId || null });
    await payment.save();

    await AuditLogModel.create({ action: "finance.payment.refund", module: "Finance", resource: "Payment", resourceId: paymentId.toString(), userId: userId || null, tenantId, details: { amount: roundedAmount, reason } });
    publishEvent("PaymentRefunded", { tenantId, paymentId: paymentId.toString(), amount: roundedAmount, performedBy: userId || null });

    return payment.toJSON();
  }

  /**
   * "A payment is when money is authorized or captured. A settlement is
   * when the money is actually transferred and finalized." (Finance
   * Module Part 23.) The real first-ever setter for the `'Settled'`
   * status — `paymentStatuses` (above) has listed it, and
   * `isPaymentRefundable` has treated it as reachable, since Part 7
   * first shipped, but nothing anywhere ever actually assigned it before
   * `SettlementService.completeSettlement` started calling this. Called
   * only by the Settlement Engine, once a real settlement has actually
   * completed — never a self-transition Payment triggers on its own.
   */
  static async markSettled(paymentId, tenantId, { settlementId = null, userId = null } = {}) {
    const payment = await PaymentService.getPaymentById(paymentId, tenantId);
    if (!isPaymentSettleable(payment.status)) {
      throw new Error(`Payment cannot be marked Settled from status "${payment.status}".`);
    }

    payment.status = "Settled";
    payment.timeline.push({ event: "PaymentSettled", description: settlementId ? `Settled via settlement ${settlementId}.` : "Settled.", performedBy: userId || "system" });
    await payment.save();

    await AuditLogModel.create({ action: "finance.payment.settle", module: "Finance", resource: "Payment", resourceId: paymentId.toString(), userId: userId || null, tenantId, details: { settlementId: settlementId ? settlementId.toString() : null } });
    publishEvent("PaymentSettled", { tenantId, paymentId: paymentId.toString(), settlementId: settlementId ? settlementId.toString() : null, performedBy: userId || "system" });

    return payment.toJSON();
  }
}

export default PaymentService;
