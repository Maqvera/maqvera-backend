import PaymentModel from "../models/PaymentModel.js";
import BookingHeaderModel from "../models/BookingHeaderModel.js";
import VisaCaseModel from "../models/VisaCaseModel.js";
import TravelPlanModel from "../models/TravelPlanModel.js";
import FinanceSequenceModel from "../models/FinanceSequenceModel.js";
import AuditLogModel from "../models/AuditLogmodel.js";
import { publishEvent } from "../utils/eventBus.js";
import { getFinanceConfig } from "../utils/financeConfig.js";
import { getGatewayAdapter } from "./gateways/index.js";
import { retryWithBackoff } from "../utils/retryWithBackoff.js";
import { PaymentAggregate } from "../domain/payment/PaymentAggregate.js";
import { PaymentRepository } from "../domain/payment/PaymentRepository.js";
import { Money } from "../domain/payment/valueObjects/Money.js";
import { resolveGateway } from "../domain/payment/policies/GatewayRoutingPolicy.js";
import { computeFraudRiskScore, deriveFraudStatus } from "../domain/payment/services/PaymentFraudDomainService.js";
import { isPaymentAllocatable } from "../domain/payment/specifications/CanAllocateSpecification.js";
import { isPaymentVoidable } from "../domain/payment/specifications/CanVoidSpecification.js";
import { isPaymentRefundable } from "../domain/payment/specifications/CanRefundSpecification.js";
import { isPaymentSettleable } from "../domain/payment/specifications/CanSettleSpecification.js";
import { isPaymentCapturable } from "../domain/payment/specifications/CanCaptureSpecification.js";

const roundCurrency = (value) => Math.round((Number(value) || 0) * 100) / 100;

// ---------------------------------------------------------------------------
// Business-rule predicates — canonically defined in domain/payment/ as of
// Improvement 16 (Enterprise DDD Internal Domain Model Standard: "Business
// logic MUST live inside the Domain Layer"). Re-exported here, unchanged in
// name and behavior, so every existing import site
// (services/PaymentIntentService.js, services/CustomerCollectionService.js,
// services/SettlementService.js, services/RefundService.js,
// tests/paymentService.test.js) keeps working with zero changes.
// ---------------------------------------------------------------------------
export { resolveGateway, computeFraudRiskScore, deriveFraudStatus, isPaymentAllocatable, isPaymentVoidable, isPaymentRefundable, isPaymentSettleable, isPaymentCapturable };

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

  /**
   * "Gateway Timeout Retry, Temporary Failure Retry, Exponential Backoff."
   * A real network/timeout error thrown by the adapter (fetch failure,
   * Stripe SDK connection error) is retried; a clean gateway decline
   * (adapter returns `{status:"Failed"}` normally, never throws for that)
   * is never retried — retrying a genuine decline can't change the
   * outcome and would just waste the retry budget.
   */
  static async _callGateway(fn, label) {
    const config = getFinanceConfig();
    return retryWithBackoff(fn, { maxAttempts: config.paymentGatewayRetryMaxAttempts, baseDelayMs: config.paymentGatewayRetryBaseDelayMs, label });
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
   *
   * `captureMode` (Part 18 Part 3) — "Automatic" (default, unchanged
   * behavior: authorize then capture in this one call) vs. "Manual"/
   * "Authorize Only"/"Delayed Capture"/"Partial Capture" (authorize only,
   * stop here with status "Authorized"; a separate `capturePayment` call
   * completes it later — Partial Capture's own smaller amount is supplied
   * to that later call, not here).
   */
  static async createPayment(data, tenantId, userId) {
    const config = getFinanceConfig();
    const { paymentType = config.defaultPaymentType, partyType = null, partyId = null, bankAccountId = null, amount, currency, paymentMethod, gateway: requestedGateway, reference = null, transactionDate, captureMode = config.defaultCaptureMode } = data;

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

    // Gateway Processing — authorize then (mode-permitting) capture. Real
    // adapter calls only; Manual settles instantly with no external round
    // trip.
    publishEvent("PaymentAuthorizationRequested", { tenantId, paymentId: payment._id.toString(), amount: roundedAmount, currency, gateway, performedBy: userId || null });
    const authResult = await PaymentService._callGateway(
      () => adapter.authorize({ amount: roundedAmount, currency, reference, paymentMethodId: data.gatewayPaymentMethodId }),
      `${gateway} authorize (${paymentNumber})`
    );
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

    // "Capture Modes... Manual Capture, Authorize Only, Partial Capture,
    // Delayed Capture" all stop here — a real, separate `capturePayment`
    // call is what actually captures the funds later.
    if (captureMode !== "Automatic") {
      await payment.save();
      await AuditLogModel.create({ action: "finance.payment.create", module: "Finance", resource: "Payment", resourceId: payment._id.toString(), userId: userId || null, tenantId, details: { paymentNumber, amount: roundedAmount, currency, gateway, riskScore: fraudCheck.riskScore, captureMode } });
      return payment.toJSON();
    }

    const captureResult = await PaymentService._callGateway(
      () => adapter.capture({ amount: roundedAmount, currency, gatewayDetails: payment.gatewayDetails }),
      `${gateway} capture (${paymentNumber})`
    );
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
    // "No payment is considered successful until verification is
    // complete." This codebase calls the gateway's own synchronous API
    // directly (no async webhook confirmation flow exists) — the capture
    // response itself IS the verification, so this fires immediately
    // after a genuinely successful capture, never before.
    publishEvent("PaymentVerificationCompleted", { tenantId, paymentId: payment._id.toString(), gateway, gatewayTransactionId: payment.gatewayDetails.transactionId, performedBy: userId || null });

    return payment.toJSON();
  }

  /**
   * Records a payment that was already collected through an external
   * channel this call did not itself initiate the capture for (e.g. a
   * Stripe Checkout Session confirmed via webhook, via BookingFinanceLinkService)
   * — same real-money-already-moved situation
   * TenantSubscriptionService.recordManualPayment handles for subscription
   * billing. Creates the Payment row directly in "Captured" status with no
   * gateway authorize/capture call — attempting either here would be a
   * second, spurious charge/capture attempt against money that has already
   * genuinely settled.
   */
  static async recordExternalPayment(data, tenantId, userId) {
    const config = getFinanceConfig();
    const { paymentType = config.defaultPaymentType, partyType = null, partyId = null, amount, currency, paymentMethod, gateway, reference = null, gatewayTransactionId = null, transactionDate } = data;

    if (!amount || amount <= 0 || !currency || !paymentMethod || !gateway) {
      throw new Error("amount, currency, paymentMethod, and gateway are required.");
    }

    const roundedAmount = roundCurrency(amount);
    const paymentNumber = await PaymentService._generatePaymentNumber(tenantId);

    const payment = await PaymentModel.create({
      tenantId,
      paymentNumber,
      paymentType,
      partyType,
      partyId,
      amount: roundedAmount,
      currency,
      paymentMethod,
      gateway,
      status: "Captured",
      reference,
      transactionDate: transactionDate ? new Date(transactionDate) : new Date(),
      unallocatedAmount: roundedAmount,
      gatewayDetails: { transactionId: gatewayTransactionId, capturedAt: new Date() },
      timeline: [{ event: "PaymentCaptured", description: `${roundedAmount} ${currency} recorded — already collected externally via ${gateway}.`, performedBy: userId || null }],
      createdBy: userId || null
    });

    await AuditLogModel.create({ action: "finance.payment.record_external", module: "Finance", resource: "Payment", resourceId: payment._id.toString(), userId: userId || null, tenantId, details: { paymentNumber, amount: roundedAmount, currency, gateway } });

    publishEvent("PaymentCreated", { tenantId, paymentId: payment._id.toString(), paymentNumber, amount: roundedAmount, currency, riskScore: 0, performedBy: userId || null });
    publishEvent("PaymentCaptured", { tenantId, paymentId: payment._id.toString(), bankAccountId: null, performedBy: userId || null });
    publishEvent("PaymentVerificationCompleted", { tenantId, paymentId: payment._id.toString(), gateway, gatewayTransactionId, performedBy: userId || null });

    return payment.toJSON();
  }

  /**
   * POST /api/v1/customer-payments/{collectionId}/capture (Part 18 Part 3)
   * — completes a payment left in "Authorized" status by a Manual/
   * Authorize Only/Delayed/Partial Capture `createPayment` call. `amount`
   * defaults to the full authorized amount; supplying a smaller amount is
   * "Partial Capture" — `payment.amount`/`unallocatedAmount` are adjusted
   * down to what was actually captured (never the larger originally-
   * authorized amount), since nothing has been allocated against this
   * payment yet at the Authorized stage.
   */
  static async capturePayment(paymentId, data, tenantId, userId) {
    const { amount = null } = data || {};
    const payment = await PaymentService.getPaymentById(paymentId, tenantId);
    const aggregate = PaymentAggregate.fromPersistence(payment);
    if (!aggregate.isCapturableStatus()) {
      throw new Error(`Payment cannot be captured from status "${payment.status}".`);
    }

    const captureAmount = amount ? roundCurrency(amount) : payment.amount;
    if (!aggregate.canCapture(captureAmount)) {
      throw new Error(`captureAmount must be greater than zero and no more than the authorized amount (${payment.amount}).`);
    }

    const adapter = getGatewayAdapter(payment.gateway);
    if (!adapter) throw new Error(`Payment gateway "${payment.gateway}" is not yet supported — no adapter is implemented for it (services/gateways/).`);

    const captureResult = await PaymentService._callGateway(
      () => adapter.capture({ amount: captureAmount, currency: payment.currency, gatewayDetails: payment.gatewayDetails }),
      `${payment.gateway} capture (${payment.paymentNumber})`
    );
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

    const { isPartial } = aggregate.applyCapture(captureAmount);
    payment.gatewayDetails.capturedAt = new Date();
    payment.timeline.push({ event: "PaymentCaptured", description: `Captured ${captureAmount} ${payment.currency}${isPartial ? " (partial)" : ""}.`, performedBy: userId || null });
    await PaymentRepository.save(payment);

    await AuditLogModel.create({ action: "finance.payment.capture", module: "Finance", resource: "Payment", resourceId: payment._id.toString(), userId: userId || null, tenantId, details: { captureAmount } });
    publishEvent("PaymentCaptured", { tenantId, paymentId: payment._id.toString(), bankAccountId: payment.bankAccountId ? payment.bankAccountId.toString() : null, performedBy: userId || null });
    publishEvent("PaymentVerificationCompleted", { tenantId, paymentId: payment._id.toString(), gateway: payment.gateway, gatewayTransactionId: payment.gatewayDetails.transactionId, performedBy: userId || null });

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

  /** Persistence lookup — delegates to the Payment Repository (domain/payment/PaymentRepository.js) rather than the Mongoose model directly (Improvement 16: "Repositories MUST abstract persistence only"). */
  static async getPaymentById(paymentId, tenantId) {
    return PaymentRepository.findById(paymentId, tenantId);
  }

  /**
   * Consumes `amount` of a payment's unallocated balance. Kept as the one
   * shared choke point every allocation path goes through — AR's own
   * allocate-payment, AP's own, and this module's generic `allocate` all
   * call it, which is what makes `payment.allocations[]` a complete,
   * trustworthy audit trail no matter which "specialized workflow"
   * triggered it (see this file's own top-of-file architecture note). Only
   * the balance sufficiency check is enforced here (status eligibility is
   * each caller's own responsibility — several callers, e.g.
   * AccountsReceivableService/AccountsPayableService/WalletService, invoke
   * this directly without going through the generic `allocate()` status
   * gate, by design). The balance/invariant mutation itself is delegated
   * to PaymentAggregate (Improvement 16) — this method stays the
   * persistence-orchestration entry point (load, ask the aggregate, save).
   */
  static async consumeUnallocatedAmount(paymentId, tenantId, amount, allocationMeta = {}) {
    const payment = await PaymentService.getPaymentById(paymentId, tenantId);
    const roundedAmount = roundCurrency(amount);
    const aggregate = PaymentAggregate.fromPersistence(payment);

    if (!aggregate.unallocatedMoney.isGreaterThanOrEqual(new Money(roundedAmount, payment.currency))) {
      throw new Error(`Payment ${paymentId} does not have enough unallocated balance: requested ${roundedAmount}, available ${payment.unallocatedAmount}.`);
    }

    aggregate.applyAllocation(roundedAmount, { targetType: allocationMeta.targetType, targetId: allocationMeta.targetId, allocatedBy: allocationMeta.allocatedBy });
    payment.timeline.push({ event: "PaymentAllocated", description: `${roundedAmount} ${payment.currency} allocated${allocationMeta.targetType ? ` to ${allocationMeta.targetType}` : ""}.`, performedBy: allocationMeta.allocatedBy || null });
    await PaymentRepository.save(payment);

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
    const aggregate = PaymentAggregate.fromPersistence(payment);
    if (!aggregate.canVoid()) {
      throw new Error(`Payment cannot be voided from status "${payment.status}".`);
    }

    const adapter = getGatewayAdapter(payment.gateway);
    if (adapter) {
      const result = await adapter.void({ gatewayDetails: payment.gatewayDetails });
      if (result.status !== "Voided") {
        throw new Error(result.failureReason || "Gateway void failed.");
      }
    }

    aggregate.applyVoid(userId || null);
    payment.timeline.push({ event: "PaymentVoided", description: data?.reason || "Payment voided.", performedBy: userId || null });
    await PaymentRepository.save(payment);

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
    const roundedAmount = roundCurrency(amount);
    const aggregate = PaymentAggregate.fromPersistence(payment);
    if (!aggregate.isRefundableStatus()) {
      throw new Error(`Payment cannot be refunded from status "${payment.status}".`);
    }
    if (!aggregate.canRefund(roundedAmount)) {
      throw new Error(`Refund amount exceeds the unallocated portion available (${payment.unallocatedAmount}). Already-allocated funds must be reversed via their own target's mechanism.`);
    }

    const adapter = getGatewayAdapter(payment.gateway);
    if (adapter) {
      const result = await adapter.refund({ amount: roundedAmount, gatewayDetails: payment.gatewayDetails });
      if (result.status !== "Refunded") {
        throw new Error(result.failureReason || "Gateway refund failed.");
      }
    }

    aggregate.applyRefund(roundedAmount);
    payment.timeline.push({ event: "PaymentRefunded", description: `${roundedAmount} ${payment.currency} refunded${reason ? `: ${reason}` : ""}.`, performedBy: userId || null });
    await PaymentRepository.save(payment);

    await AuditLogModel.create({ action: "finance.payment.refund", module: "Finance", resource: "Payment", resourceId: paymentId.toString(), userId: userId || null, tenantId, details: { amount: roundedAmount, reason } });
    publishEvent("PaymentRefunded", { tenantId, paymentId: paymentId.toString(), amount: roundedAmount, performedBy: userId || null });

    return payment.toJSON();
  }

  /**
   * "Manual Retry" (Part 18 Part 5's own Payment Retry Engine). Creates a
   * genuinely NEW Payment through the exact same `createPayment` flow
   * (fresh fraud check, fresh gateway authorize+capture) — never mutates
   * or resurrects the original Failed record, preserving its immutable
   * history exactly as-is. Bounded by `paymentManualRetryMaxAttempts`
   * counted on the ORIGINAL payment, so a caller can't retry the same
   * failure forever ("Dead Letter Queue" honest equivalent — see
   * `paymentManualRetryMaxAttempts`'s own doc comment).
   */
  static async retryPayment(paymentId, tenantId, userId) {
    const config = getFinanceConfig();
    const original = await PaymentService.getPaymentById(paymentId, tenantId);
    if (original.status !== "Failed") throw new Error(`Cannot retry a payment that is not Failed (status "${original.status}").`);
    if (original.retryCount >= config.paymentManualRetryMaxAttempts) {
      throw new Error(`Retry count exceeds the configured maximum of ${config.paymentManualRetryMaxAttempts} attempt(s).`);
    }

    const retryPaymentRecord = await PaymentService.createPayment({
      paymentType: original.paymentType, partyType: original.partyType, partyId: original.partyId, bankAccountId: original.bankAccountId,
      amount: original.amount, currency: original.currency, paymentMethod: original.paymentMethod, gateway: original.gateway,
      reference: original.reference, captureMode: "Automatic"
    }, tenantId, userId);

    await PaymentModel.updateOne({ _id: original._id, tenantId }, {
      $inc: { retryCount: 1 },
      $push: { timeline: { event: "PaymentRetried", description: `Manually retried as payment ${retryPaymentRecord.paymentNumber}.`, performedBy: userId || null } }
    });
    await PaymentModel.updateOne({ _id: retryPaymentRecord._id, tenantId }, { $set: { retryOf: original._id } });

    await AuditLogModel.create({ action: "finance.payment.retry", module: "Finance", resource: "Payment", resourceId: original._id.toString(), userId: userId || null, tenantId, details: { retryPaymentId: retryPaymentRecord._id.toString() } });

    return retryPaymentRecord;
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
    const aggregate = PaymentAggregate.fromPersistence(payment);
    if (!aggregate.canSettle()) {
      throw new Error(`Payment cannot be marked Settled from status "${payment.status}".`);
    }

    aggregate.applySettle();
    payment.timeline.push({ event: "PaymentSettled", description: settlementId ? `Settled via settlement ${settlementId}.` : "Settled.", performedBy: userId || "system" });
    await PaymentRepository.save(payment);

    await AuditLogModel.create({ action: "finance.payment.settle", module: "Finance", resource: "Payment", resourceId: paymentId.toString(), userId: userId || null, tenantId, details: { settlementId: settlementId ? settlementId.toString() : null } });
    publishEvent("PaymentSettled", { tenantId, paymentId: paymentId.toString(), settlementId: settlementId ? settlementId.toString() : null, performedBy: userId || "system" });

    return payment.toJSON();
  }
}

export default PaymentService;
