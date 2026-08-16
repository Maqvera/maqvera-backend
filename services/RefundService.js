import RefundModel from "../models/RefundModel.js";
import PaymentModel from "../models/PaymentModel.js";
import CreditNoteModel from "../models/CreditNoteModel.js";
import CustomerCreditModel from "../models/CustomerCreditModel.js";
import CustomerCreditService from "./CustomerCreditService.js";
import JournalService from "./JournalService.js";
import FinancialPeriodService from "./FinancialPeriodService.js";
import FinanceSequenceModel from "../models/FinanceSequenceModel.js";
import AuditLogModel from "../models/AuditLogmodel.js";
import { getGatewayAdapter } from "./gateways/index.js";
import { isPaymentRefundable } from "./PaymentService.js";
import { subscribeEvent, publishEvent } from "../utils/eventBus.js";
import { getFinanceConfig } from "../utils/financeConfig.js";

const roundCurrency = (value) => Math.round((Number(value) || 0) * 100) / 100;

// ---------------------------------------------------------------------------
// Pure helpers — no DB access, unit-testable directly (see
// tests/refundService.test.js).
// ---------------------------------------------------------------------------

/**
 * "Refund Eligibility... Checks: Payment Status, Business Rules, Time
 * Window." These are real, hard-blocking rules (unlike the Fraud Risk score
 * below, which is explicitly "AI advisory only"). Takes pre-resolved
 * values/flags — the DB-backed wrapper (RefundService.createRefund) gathers
 * them; this stays pure and testable.
 */
export const computeRefundEligibility = ({ isPaymentStatusEligible, remainingRefundableAmount, refundAmount, daysSincePayment, refundWindowDays }) => {
  const reasons = [];
  if (isPaymentStatusEligible === false) reasons.push("Payment is not in a refundable status.");
  if (!(refundAmount > 0)) reasons.push("A positive refundAmount is required.");
  if (remainingRefundableAmount !== null && refundAmount > remainingRefundableAmount) {
    reasons.push(`Refund amount exceeds the remaining refundable amount (${remainingRefundableAmount}).`);
  }
  const withinTimeWindow = !refundWindowDays || refundWindowDays <= 0 || daysSincePayment === null || daysSincePayment <= refundWindowDays;
  if (!withinTimeWindow) reasons.push(`Refund requested outside the allowed window (${refundWindowDays} days since payment).`);
  return { eligible: reasons.length === 0, reasons, withinTimeWindow };
};

/**
 * Rule-based (not AI) fraud signal — "Duplicate Refund, High Refund
 * Frequency, High Amount." Mirrors PaymentService.computeFraudRiskScore's
 * exact shape, kept as its own small copy (not imported) since the flag
 * names are Refund-specific per the spec's own wording. "AI advisory
 * only" — RefundService never blocks creation on this score, only records
 * it for the approver.
 */
export const computeRefundRiskScore = ({ isDuplicate, velocityCount, velocityMax, amount, amountThreshold }) => {
  const flags = [];
  let riskScore = 0;
  if (isDuplicate) { flags.push("DuplicateRefund"); riskScore += 40; }
  if (velocityCount > velocityMax) { flags.push("HighRefundFrequency"); riskScore += 30; }
  if (amount >= amountThreshold) { flags.push("HighAmount"); riskScore += 30; }
  return { riskScore: Math.min(riskScore, 100), flags };
};

/**
 * "Approval Policies... Amount Based" — approval is required whenever
 * EITHER the boolean gate is on OR the amount reaches the configured
 * threshold (0/unset = no threshold-forced approval).
 */
export const isRefundApprovalRequired = (amount, config) =>
  config.refundApprovalRequired || (config.refundApprovalAmountThreshold > 0 && amount >= config.refundApprovalAmountThreshold);

const APPROVABLE_STATUSES = new Set(["Requested", "Under Review"]);
const REJECTABLE_STATUSES = new Set(["Requested", "Under Review"]);
const CANCELLABLE_STATUSES = new Set(["Requested", "Under Review", "Approved"]);

export const isRefundReviewable = (status) => status === "Requested";
export const isRefundApprovable = (status) => APPROVABLE_STATUSES.has(status);
export const isRefundRejectable = (status) => REJECTABLE_STATUSES.has(status);
export const isRefundProcessable = (status) => status === "Approved";
export const isRefundCancellable = (status) => CANCELLABLE_STATUSES.has(status);

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

class RefundService {
  /**
   * Wires Part 10's own `RefundRequested` event (fired by
   * CreditNoteService.allocateCreditNote when `disposition === "Refund"`) to
   * real auto-creation of a Refund document — closing the exact gap Part
   * 10's own doc comment named ("a genuine signal for finance-ops or a
   * future Refund Management module"). This service's own createRefund also
   * publishes `RefundRequested` (matching the spec's Domain Events list), so
   * the listener strictly requires `payload.creditNoteId` (Part 10's own
   * payload shape) to avoid re-triggering itself off its own publish — the
   * direct-payment creation path never reaches this listener. Auto-creation
   * only reaches "Requested"/"Approved" per the normal approval gate — it
   * never auto-processes money movement.
   */
  static _eventListenersInitialized = false;
  static initEventListeners() {
    if (RefundService._eventListenersInitialized) return;
    RefundService._eventListenersInitialized = true;

    subscribeEvent("RefundRequested", async (payload) => {
      if (!payload?.tenantId || !payload?.creditNoteId) return;
      try {
        const existing = await RefundModel.findOne({ tenantId: payload.tenantId, creditNoteId: payload.creditNoteId }).lean();
        if (existing) return;
        await RefundService.createRefund({
          creditNoteId: payload.creditNoteId,
          reason: payload.reason || "Credit note disposition: Refund",
          refundMethod: "Bank Transfer"
        }, payload.tenantId, payload.performedBy || "system", { suppressEvent: true });
      } catch (error) {
        console.error("RefundService.RefundRequested handler failed:", error.message);
      }
    });
  }

  static async _generateRefundNumber(tenantId) {
    const config = getFinanceConfig();
    const year = `${new Date().getUTCFullYear()}`;
    const seq = await FinanceSequenceModel.getNext(tenantId, "refundNumber", year);
    return `${config.refundNumberPrefix}-${year}-${String(seq).padStart(6, "0")}`;
  }

  /** Sums every non-terminal-failed refund already reserved against a payment. */
  static async _sumReservedRefunds(tenantId, paymentId, excludeRefundId = null) {
    const filter = { tenantId, paymentId, status: { $in: ["Requested", "Under Review", "Approved", "Processing", "Completed"] } };
    if (excludeRefundId) filter._id = { $ne: excludeRefundId };
    const refunds = await RefundModel.find(filter).select("refundAmount").lean();
    return roundCurrency(refunds.reduce((sum, r) => sum + r.refundAmount, 0));
  }

  /** DB-backed wrapper around computeRefundRiskScore — gathers the real counts. */
  static async _runRiskCheck({ tenantId, amount, currency, paymentId }) {
    const config = getFinanceConfig();
    const now = Date.now();

    const duplicateSince = new Date(now - config.fraudDuplicateWindowMinutes * 60 * 1000);
    const isDuplicate = paymentId
      ? !!(await RefundModel.findOne({ tenantId, paymentId, refundAmount: amount, currency, createdAt: { $gte: duplicateSince } }).lean())
      : false;

    const velocitySince = new Date(now - config.fraudVelocityWindowMinutes * 60 * 1000);
    const velocityCount = paymentId
      ? await RefundModel.countDocuments({ tenantId, paymentId, createdAt: { $gte: velocitySince } })
      : 0;

    return computeRefundRiskScore({ isDuplicate, velocityCount, velocityMax: config.fraudVelocityMaxCount, amount, amountThreshold: config.fraudAmountThreshold });
  }

  /**
   * POST /api/v1/refunds
   * Validate Payment/Credit Note -> Validate Refund Eligibility -> Validate
   * Remaining Refund Amount -> Fraud Risk (advisory) -> Approval Workflow ->
   * Timeline -> Audit -> Publish RefundCreated/RefundApproved.
   *
   * Two independent, real creation paths — see RefundModel.js doc comment:
   * - `paymentId` only: "Refund without Credit Note" (the spec's own
   *   request example).
   * - `creditNoteId` only (or both): "Credit Note + Refund" — redeems the
   *   specific CustomerCredit Part 10's own allocation produced, rather than
   *   touching Accounts Receivable again (Credit Note already adjusted it —
   *   Refund only moves cash, per this Part's own "Credit Note is an
   *   accounting document; Refund is the actual movement of money" rule).
   */
  static async createRefund(data, tenantId, userId, options = {}) {
    const config = getFinanceConfig();
    const { paymentId = null, creditNoteId = null, bankAccountId = null, refundAmount = null, reason, refundMethod = config.defaultRefundMethod } = data;

    if (!reason) throw new Error("reason is required.");
    if (!config.refundMethods.includes(refundMethod)) throw new Error(`Invalid refundMethod "${refundMethod}".`);
    if (!paymentId && !creditNoteId) throw new Error("Either paymentId or creditNoteId is required.");
    if (refundMethod === "Original Gateway" && !paymentId) {
      throw new Error('paymentId is required when refundMethod is "Original Gateway".');
    }

    let payment = null;
    let creditNote = null;
    let customerId = null;
    let customerName = null;
    let currency = null;
    let invoiceId = null;
    let remainingRefundableAmount = null;
    let daysSincePayment = null;

    if (paymentId) {
      payment = await PaymentModel.findOne({ _id: paymentId, tenantId });
      if (!payment) throw new Error("Payment not found.");
      currency = payment.currency;
      if (payment.partyType === "customer" && payment.partyId) customerId = payment.partyId;
      const reserved = await RefundService._sumReservedRefunds(tenantId, payment._id);
      remainingRefundableAmount = roundCurrency(payment.amount - payment.refundedAmount - reserved);
      daysSincePayment = Math.floor((Date.now() - new Date(payment.transactionDate).getTime()) / (24 * 60 * 60 * 1000));
    }

    if (creditNoteId) {
      creditNote = await CreditNoteModel.findOne({ _id: creditNoteId, tenantId });
      if (!creditNote) throw new Error("Credit note not found.");
      if (creditNote.disposition !== "Refund") {
        throw new Error('Credit note disposition is not "Refund" — its credit was issued as reusable Customer Credit, not requested as cash.');
      }
      if (!["Allocated", "Closed"].includes(creditNote.status)) {
        throw new Error(`Credit note must be Allocated before a refund can be raised against it (status: "${creditNote.status}").`);
      }
      if (!creditNote.customerCreditId) throw new Error("Credit note has no linked Customer Credit to redeem.");
      const credit = await CustomerCreditModel.findOne({ _id: creditNote.customerCreditId, tenantId }).lean();
      if (!credit || credit.status !== "Active" || credit.remainingAmount <= 0) {
        throw new Error("The Customer Credit produced by this credit note has already been fully redeemed or consumed.");
      }
      customerId = creditNote.customerId;
      customerName = creditNote.customerName;
      currency = currency || creditNote.currency;
      invoiceId = creditNote.invoiceId;
      remainingRefundableAmount = remainingRefundableAmount === null ? credit.remainingAmount : Math.min(remainingRefundableAmount, credit.remainingAmount);
    }

    const resolvedAmount = roundCurrency(refundAmount !== null ? refundAmount : remainingRefundableAmount);

    const eligibility = computeRefundEligibility({
      isPaymentStatusEligible: payment ? isPaymentRefundable(payment.status) : true,
      remainingRefundableAmount,
      refundAmount: resolvedAmount,
      daysSincePayment,
      refundWindowDays: config.refundWindowDays
    });
    if (!eligibility.eligible) throw new Error(eligibility.reasons.join(" "));

    await FinancialPeriodService.assertPeriodOpen(tenantId, new Date());

    const riskCheck = await RefundService._runRiskCheck({ tenantId, amount: resolvedAmount, currency, paymentId });
    const refundNumber = await RefundService._generateRefundNumber(tenantId);
    const approvalRequired = isRefundApprovalRequired(resolvedAmount, config);
    const initialStatus = approvalRequired ? config.defaultRefundStatus : "Approved";

    const refund = new RefundModel({
      tenantId,
      refundNumber,
      paymentId: payment ? payment._id : null,
      paymentNumber: payment ? payment.paymentNumber : null,
      creditNoteId: creditNote ? creditNote._id : null,
      invoiceId,
      bankAccountId,
      customerId,
      customerName,
      refundAmount: resolvedAmount,
      currency,
      refundMethod,
      gateway: refundMethod === "Original Gateway" ? payment.gateway : null,
      reason,
      status: initialStatus,
      eligibility: { withinTimeWindow: eligibility.withinTimeWindow, remainingRefundableAmount, checkedAt: new Date() },
      riskCheck: { riskScore: riskCheck.riskScore, flags: riskCheck.flags, checkedAt: new Date() },
      timeline: [{ event: "RefundRequested", description: `Refund of ${resolvedAmount} ${currency} requested.`, performedBy: userId || null }],
      createdBy: userId || null,
      updatedBy: userId || null
    });
    if (initialStatus === "Approved") {
      refund.approvedBy = "system";
      refund.approvedAt = new Date();
      refund.timeline.push({ event: "RefundApproved", description: "Auto-approved — below the configured approval threshold.", performedBy: "system" });
    }
    await refund.save();

    await AuditLogModel.create({ action: "finance.refund.create", module: "Finance", resource: "Refund", resourceId: refund._id.toString(), userId: userId || null, tenantId, details: { refundNumber, paymentId: paymentId ? paymentId.toString() : null, creditNoteId: creditNoteId ? creditNoteId.toString() : null, refundAmount: resolvedAmount, riskScore: riskCheck.riskScore } });

    if (!options.suppressEvent) {
      publishEvent("RefundRequested", { tenantId, refundId: refund._id.toString(), paymentId: paymentId ? paymentId.toString() : null, creditNoteId: creditNoteId ? creditNoteId.toString() : null, refundAmount: resolvedAmount, performedBy: userId || null });
    }
    if (initialStatus === "Approved") {
      publishEvent("RefundApproved", { tenantId, refundId: refund._id.toString(), refundAmount: resolvedAmount, performedBy: "system" });
    }

    return refund.toJSON();
  }

  /**
   * GET /api/v1/refunds
   */
  static async listRefunds(query, tenantId) {
    const config = getFinanceConfig();
    const { customerId, paymentId, creditNoteId, status, refundMethod, currency } = query;
    const filter = { tenantId };
    if (customerId) filter.customerId = customerId;
    if (paymentId) filter.paymentId = paymentId;
    if (creditNoteId) filter.creditNoteId = creditNoteId;
    if (status) filter.status = status;
    if (refundMethod) filter.refundMethod = refundMethod;
    if (currency) filter.currency = currency;
    if (query.dateFrom || query.dateTo) {
      filter.createdAt = {};
      if (query.dateFrom) filter.createdAt.$gte = new Date(query.dateFrom);
      if (query.dateTo) filter.createdAt.$lte = new Date(query.dateTo);
    }

    const page = Math.max(parseInt(query.page, 10) || 1, 1);
    const pageSize = Math.min(Math.max(parseInt(query.pageSize, 10) || config.defaultPageSize, 1), config.maxPageSize);
    const skip = (page - 1) * pageSize;

    let sortSpec = { createdAt: -1 };
    if (query.sort) {
      const direction = query.sort.startsWith("-") ? -1 : 1;
      const field = query.sort.replace(/^-/, "");
      sortSpec = { [field]: direction };
    }

    const [items, total] = await Promise.all([
      RefundModel.find(filter).sort(sortSpec).skip(skip).limit(pageSize).lean(),
      RefundModel.countDocuments(filter)
    ]);

    return { items, pagination: { total, page, pageSize, totalPages: Math.ceil(total / pageSize) } };
  }

  /**
   * GET /api/v1/refunds/{refundId}
   */
  static async getRefundById(refundId, tenantId) {
    const refund = await RefundModel.findOne({ _id: refundId, tenantId }).lean();
    if (!refund) throw new Error("Refund not found.");

    const auditSummary = await AuditLogModel.find({ tenantId, resource: "Refund", resourceId: refund._id.toString() }).sort({ createdAt: -1 }).limit(20).lean();
    return { ...refund, auditSummary };
  }

  /**
   * POST /api/v1/refunds/{refundId}/review — gap-fill. The Lifecycle
   * diagram draws "Under Review" as its own distinct state between
   * Requested and Approved (same "the diagram's states are the real
   * contract" reading already applied to every gated-lifecycle module this
   * session), but the Domain Events list has no event named for reaching
   * it — so this transition updates state/timeline/audit only, honestly,
   * with no invented event.
   */
  static async reviewRefund(refundId, tenantId, userId) {
    const refund = await RefundModel.findOne({ _id: refundId, tenantId });
    if (!refund) throw new Error("Refund not found.");
    if (!isRefundReviewable(refund.status)) throw new Error(`Refund cannot be moved to review from status "${refund.status}".`);

    refund.status = "Under Review";
    refund.updatedBy = userId || null;
    refund.timeline.push({ event: "RefundUnderReview", description: "Refund moved to review.", performedBy: userId || null });
    await refund.save();

    await AuditLogModel.create({ action: "finance.refund.review", module: "Finance", resource: "Refund", resourceId: refund._id.toString(), userId: userId || null, tenantId, details: {} });

    return refund.toJSON();
  }

  /**
   * POST /api/v1/refunds/{refundId}/approve
   */
  static async approveRefund(refundId, tenantId, userId) {
    const refund = await RefundModel.findOne({ _id: refundId, tenantId });
    if (!refund) throw new Error("Refund not found.");
    if (!isRefundApprovable(refund.status)) throw new Error(`Refund cannot be approved from status "${refund.status}".`);

    refund.status = "Approved";
    refund.approvedBy = userId || null;
    refund.approvedAt = new Date();
    refund.updatedBy = userId || null;
    refund.timeline.push({ event: "RefundApproved", description: "Refund approved.", performedBy: userId || null });
    await refund.save();

    await AuditLogModel.create({ action: "finance.refund.approve", module: "Finance", resource: "Refund", resourceId: refund._id.toString(), userId: userId || null, tenantId, details: {} });
    publishEvent("RefundApproved", { tenantId, refundId: refund._id.toString(), refundAmount: refund.refundAmount, performedBy: userId || null });

    return refund.toJSON();
  }

  /**
   * POST /api/v1/refunds/{refundId}/reject — unlike Credit Note/Debit Note,
   * this spec's own Domain Events list DOES name `RefundRejected`, so
   * (following this session's own established rule of only building an
   * action when a named event reaches it) reject gets its own dedicated
   * endpoint here, distinct from cancel.
   */
  static async rejectRefund(refundId, data, tenantId, userId) {
    const refund = await RefundModel.findOne({ _id: refundId, tenantId });
    if (!refund) throw new Error("Refund not found.");
    if (!isRefundRejectable(refund.status)) throw new Error(`Refund cannot be rejected from status "${refund.status}".`);

    refund.status = "Rejected";
    refund.rejectedBy = userId || null;
    refund.rejectedAt = new Date();
    refund.rejectionReason = data?.reason || null;
    refund.updatedBy = userId || null;
    refund.timeline.push({ event: "RefundRejected", description: data?.reason || "Refund rejected.", performedBy: userId || null });
    await refund.save();

    await AuditLogModel.create({ action: "finance.refund.reject", module: "Finance", resource: "Refund", resourceId: refund._id.toString(), userId: userId || null, tenantId, details: { reason: data?.reason || null } });
    publishEvent("RefundRejected", { tenantId, refundId: refund._id.toString(), reason: data?.reason || null, performedBy: userId || null });

    return refund.toJSON();
  }

  /**
   * POST /api/v1/refunds/{refundId}/process — Approved -> Processing ->
   * Completed/Failed, synchronously (this codebase has no webhook receiver
   * to complete an async gateway callback later — same honest deferral
   * category as Payment's own synchronous authorize+capture). This is where
   * money actually moves: Original Gateway calls the real adapter against
   * the original payment's transaction; Customer Wallet/Store Credit
   * creates real, immediately-usable CustomerCredit (redeeming the specific
   * credit-note-produced credit first, when linked); Bank Transfer/Cash/
   * Cheque/Custom Method settle instantly (no external API exists for
   * these, same category as ManualGatewayAdapter). Then posts the ledger
   * journal and updates Payment bookkeeping.
   */
  static async processRefund(refundId, tenantId, userId) {
    const config = getFinanceConfig();
    const refund = await RefundModel.findOne({ _id: refundId, tenantId });
    if (!refund) throw new Error("Refund not found.");
    if (!isRefundProcessable(refund.status)) throw new Error(`Refund cannot be processed from status "${refund.status}".`);

    await FinancialPeriodService.assertPeriodOpen(tenantId, new Date());

    refund.status = "Processing";
    refund.processedAt = new Date();
    refund.timeline.push({ event: "RefundProcessing", description: "Refund processing started.", performedBy: userId || null });
    await refund.save();
    publishEvent("RefundProcessing", { tenantId, refundId: refund._id.toString(), performedBy: userId || null });

    const payment = refund.paymentId ? await PaymentModel.findOne({ _id: refund.paymentId, tenantId }) : null;

    try {
      if (refund.refundMethod === "Original Gateway") {
        if (!payment) throw new Error("Original payment no longer exists.");
        const adapter = getGatewayAdapter(refund.gateway || payment.gateway);
        if (!adapter) throw new Error(`Payment gateway "${refund.gateway || payment.gateway}" is not supported.`);
        const result = await adapter.refund({ amount: refund.refundAmount, gatewayDetails: payment.gatewayDetails });
        if (result.status !== "Refunded") throw new Error(result.failureReason || "Gateway refund failed.");
        refund.gatewayDetails = { transactionId: result.transactionId || null, rawResponse: result.rawResponse || null };
      } else if (refund.refundMethod === "Customer Wallet" || refund.refundMethod === "Store Credit") {
        if (!refund.customerId) throw new Error("customerId is required for a wallet/store-credit refund.");
        if (refund.creditNoteId) {
          const creditNote = await CreditNoteModel.findOne({ _id: refund.creditNoteId, tenantId }).lean();
          await CustomerCreditService.consumeCreditById(creditNote.customerCreditId, tenantId, refund.refundAmount);
        }
        const credit = await CustomerCreditService.createCredit({ customerId: refund.customerId, amount: refund.refundAmount, currency: refund.currency, source: "RefundAdjustment", sourceReferenceId: refund._id }, tenantId, userId);
        refund.customerCreditId = credit._id;
      } else {
        // Bank Transfer / Cash / Cheque / Custom Method.
        if (refund.creditNoteId) {
          const creditNote = await CreditNoteModel.findOne({ _id: refund.creditNoteId, tenantId }).lean();
          await CustomerCreditService.consumeCreditById(creditNote.customerCreditId, tenantId, refund.refundAmount);
        }
      }
    } catch (error) {
      refund.status = "Failed";
      refund.failureReason = error.message;
      refund.timeline.push({ event: "RefundFailed", description: error.message, performedBy: userId || null });
      await refund.save();
      await AuditLogModel.create({ action: "finance.refund.process", module: "Finance", resource: "Refund", resourceId: refund._id.toString(), userId: userId || null, tenantId, details: { failed: true, reason: error.message } });
      publishEvent("RefundFailed", { tenantId, refundId: refund._id.toString(), reason: error.message, performedBy: userId || null });
      return refund.toJSON();
    }

    // Ledger posting — real cash-out methods debit Revenue / credit Cash;
    // wallet/store-credit methods (no cash left the business yet) debit
    // Revenue / credit the Customer Credit Liability account instead. Same
    // "skip posting until both codes are configured" fallback as every
    // other optional account code in this module.
    let journalId = null;
    const isCashMovement = !["Customer Wallet", "Store Credit"].includes(refund.refundMethod);
    const creditAccountCode = isCashMovement ? config.defaultCashAccountCode : config.customerCreditLiabilityAccountCode;
    if (config.defaultRevenueAccountCode && creditAccountCode) {
      const journal = await JournalService.createJournal({
        journalType: "Automatic",
        postingDate: new Date(),
        description: `Refund ${refund.refundNumber}${refund.paymentNumber ? ` for payment ${refund.paymentNumber}` : ""}`,
        referenceNumber: refund.refundNumber,
        currency: refund.currency,
        lines: [
          { accountCode: config.defaultRevenueAccountCode, debit: refund.refundAmount },
          { accountCode: creditAccountCode, credit: refund.refundAmount }
        ]
      }, tenantId, userId || "system");
      await JournalService.approveJournal(journal._id, tenantId, userId || "system");
      const posted = await JournalService.postJournal(journal._id, tenantId, userId || "system");
      journalId = posted?._id || journal._id;
    }

    // Payment bookkeeping — only when this refund is against a real
    // Payment. refundedAmount always tracks the running total; only the
    // portion still genuinely unallocated on the payment comes off
    // unallocatedAmount, so money already allocated elsewhere (e.g. applied
    // to AR, then separately reduced by a Credit Note) is never
    // double-subtracted here.
    if (payment) {
      const consumedFromUnallocated = roundCurrency(Math.min(refund.refundAmount, payment.unallocatedAmount));
      payment.unallocatedAmount = roundCurrency(payment.unallocatedAmount - consumedFromUnallocated);
      payment.refundedAmount = roundCurrency(payment.refundedAmount + refund.refundAmount);
      if (payment.unallocatedAmount === 0 && payment.refundedAmount >= payment.amount) payment.status = "Refunded";
      payment.timeline.push({ event: "PaymentRefunded", description: `${refund.refundAmount} ${refund.currency} refunded via ${refund.refundMethod} (${refund.refundNumber}).`, performedBy: userId || null });
      await payment.save();
    }

    refund.status = "Completed";
    refund.completedAt = new Date();
    refund.journalId = journalId;
    refund.updatedBy = userId || null;
    refund.timeline.push({ event: "RefundCompleted", description: `Refund of ${refund.refundAmount} ${refund.currency} completed via ${refund.refundMethod}.`, performedBy: userId || null });
    await refund.save();

    await AuditLogModel.create({ action: "finance.refund.process", module: "Finance", resource: "Refund", resourceId: refund._id.toString(), userId: userId || null, tenantId, details: { refundAmount: refund.refundAmount, refundMethod: refund.refundMethod, journalId: journalId ? journalId.toString() : null } });
    publishEvent("RefundCompleted", { tenantId, refundId: refund._id.toString(), paymentId: refund.paymentId ? refund.paymentId.toString() : null, creditNoteId: refund.creditNoteId ? refund.creditNoteId.toString() : null, bankAccountId: refund.bankAccountId ? refund.bankAccountId.toString() : null, refundAmount: refund.refundAmount, refundMethod: refund.refundMethod, performedBy: userId || null });
    if (payment && payment.status === "Refunded") {
      publishEvent("PaymentRefunded", { tenantId, paymentId: payment._id.toString(), amount: refund.refundAmount, performedBy: userId || null });
    }

    return refund.toJSON();
  }

  /**
   * POST /api/v1/refunds/{refundId}/cancel — pre-processing only.
   */
  static async cancelRefund(refundId, data, tenantId, userId) {
    const refund = await RefundModel.findOne({ _id: refundId, tenantId });
    if (!refund) throw new Error("Refund not found.");
    if (!isRefundCancellable(refund.status)) throw new Error(`Refund cannot be cancelled from status "${refund.status}".`);

    refund.status = "Cancelled";
    refund.cancelledBy = userId || null;
    refund.cancelledAt = new Date();
    refund.cancellationReason = data?.reason || null;
    refund.updatedBy = userId || null;
    refund.timeline.push({ event: "RefundCancelled", description: data?.reason || "Refund cancelled.", performedBy: userId || null });
    await refund.save();

    await AuditLogModel.create({ action: "finance.refund.cancel", module: "Finance", resource: "Refund", resourceId: refund._id.toString(), userId: userId || null, tenantId, details: { reason: data?.reason || null } });
    publishEvent("RefundCancelled", { tenantId, refundId: refund._id.toString(), performedBy: userId || null });

    return refund.toJSON();
  }
}

export default RefundService;
