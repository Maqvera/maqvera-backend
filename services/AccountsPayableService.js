import AccountsPayableModel from "../models/AccountsPayableModel.js";
import VendorModel from "../models/VendorModel.js";
import AuditLogModel from "../models/AuditLogmodel.js";
import PaymentService from "./PaymentService.js";
import VendorCreditService from "./VendorCreditService.js";
import JournalService from "./JournalService.js";
import FinanceSequenceModel from "../models/FinanceSequenceModel.js";
import { publishEvent } from "../utils/eventBus.js";
import { getFinanceConfig } from "../utils/financeConfig.js";
import { computeAgingBucket } from "../utils/agingUtils.js";
import { computeOverpaymentSplit, resolveStatusAfterPayment } from "../utils/paymentAllocationUtils.js";

const roundCurrency = (value) => Math.round((Number(value) || 0) * 100) / 100;

// Re-exported for tests/callers that want AP-specific naming symmetry with
// AccountsReceivableService — same shared implementations underneath.
export { computeAgingBucket, computeOverpaymentSplit, resolveStatusAfterPayment };

// Payable statuses that never accept a payment allocation, approval, or write-off.
const TERMINAL_STATUSES = new Set(["Paid", "Settled", "Written Off", "Cancelled"]);
// Statuses eligible to receive a payment allocation — unlike AR, this
// excludes "Draft"/"Pending Approval": a payable must clear approval first
// (Payable Lifecycle: Draft -> Pending Approval -> Approved -> Open).
const PAYABLE_ELIGIBLE_STATUSES = new Set(["Open", "Partially Paid"]);
// A Debit Note's entire purpose is to reopen an already-settled payable and
// charge more — "Paid" is deliberately NOT in this set (unlike
// TERMINAL_STATUSES above). Only genuine dead ends block it. See
// applyDebitNote below (mirrors AccountsReceivableService's own).
const DEBIT_NOTE_BLOCKED_STATUSES = new Set(["Written Off", "Cancelled"]);

/** Pure predicate — testable without a DB. See PAYABLE_ELIGIBLE_STATUSES above. */
export const isPayableEligibleForPayment = (status) => PAYABLE_ELIGIBLE_STATUSES.has(status);

/** Pure predicate — testable without a DB. See TERMINAL_STATUSES above. */
export const isPayableTerminal = (status) => TERMINAL_STATUSES.has(status);

class AccountsPayableService {
  static async _resolveInvoiceNumber(tenantId, invoiceNumber) {
    if (invoiceNumber) return invoiceNumber;
    const year = `${new Date().getUTCFullYear()}`;
    const seq = await FinanceSequenceModel.getNext(tenantId, "payableManualNumber", year);
    return `AP-${year}-${String(seq).padStart(6, "0")}`;
  }

  static _decorate(payable, referenceDate = new Date()) {
    const config = getFinanceConfig();
    const { label, daysOverdue } = computeAgingBucket(payable.dueDate, referenceDate, config.agingBuckets);
    return { ...payable, agingBucket: label, daysOverdue };
  }

  /**
   * GET /api/v1/accounts-payable
   */
  static async listPayables(query, tenantId) {
    const config = getFinanceConfig();
    const { vendorId, status, currency, overdue, sort } = query;

    const filter = { tenantId };
    if (vendorId) filter.vendorId = vendorId;
    if (status) filter.status = status;
    if (currency) filter.currency = currency;
    if (query.dueDateFrom || query.dueDateTo) {
      filter.dueDate = {};
      if (query.dueDateFrom) filter.dueDate.$gte = new Date(query.dueDateFrom);
      if (query.dueDateTo) filter.dueDate.$lte = new Date(query.dueDateTo);
    }
    if (overdue === "true" || overdue === true) {
      filter.dueDate = { ...(filter.dueDate || {}), $lt: new Date() };
      filter.status = { $in: ["Open", "Partially Paid"] };
    }

    const page = Math.max(parseInt(query.page, 10) || 1, 1);
    const pageSize = Math.min(Math.max(parseInt(query.pageSize, 10) || config.defaultPageSize, 1), config.maxPageSize);
    const skip = (page - 1) * pageSize;

    let sortSpec = { dueDate: 1 };
    if (sort) {
      const direction = sort.startsWith("-") ? -1 : 1;
      const field = sort.replace(/^-/, "");
      sortSpec = { [field]: direction };
    }

    const [items, total] = await Promise.all([
      AccountsPayableModel.find(filter).sort(sortSpec).skip(skip).limit(pageSize).lean(),
      AccountsPayableModel.countDocuments(filter)
    ]);

    const now = new Date();
    return { items: items.map((item) => AccountsPayableService._decorate(item, now)), pagination: { total, page, pageSize, totalPages: Math.ceil(total / pageSize) } };
  }

  /**
   * GET /api/v1/accounts-payable/{payableId}
   */
  static async getPayableById(payableId, tenantId) {
    const payable = await AccountsPayableModel.findOne({ _id: payableId, tenantId }).lean();
    if (!payable) throw new Error("Payable not found.");

    const auditSummary = await AuditLogModel.find({
      tenantId,
      resource: "AccountsPayable",
      resourceId: payable._id.toString()
    }).sort({ createdAt: -1 }).limit(20).lean();

    return { ...AccountsPayableService._decorate(payable), auditSummary };
  }

  /**
   * Gap-fill: no "create payable" endpoint was contracted, and unlike AR
   * there is no upstream module event to subscribe to either (no
   * "VendorInvoiceCreated" appears anywhere in Part 6's own Domain Events
   * list — Purchasing/vendor-invoicing simply doesn't exist yet as a
   * module). `PayableCreated` is this module's actual entry point.
   *
   * "Advance linked automatically when invoice arrives": any Active Vendor
   * Credit for this vendor (in this currency) is consumed automatically,
   * oldest first, up to the new payable's amount.
   */
  static async createPayable(data, tenantId, userId) {
    const config = getFinanceConfig();
    const { vendorId, invoiceNumber, invoiceDate, dueDate, originalAmount, currency, expenseAccountCode = null } = data;

    if (!vendorId || !dueDate || !originalAmount || !currency) {
      throw new Error("vendorId, dueDate, originalAmount, and currency are required.");
    }

    const vendor = await VendorModel.findOne({ _id: vendorId, tenantId }).lean();
    if (!vendor) throw new Error("Vendor not found.");

    const roundedAmount = roundCurrency(originalAmount);
    const resolvedInvoiceNumber = await AccountsPayableService._resolveInvoiceNumber(tenantId, invoiceNumber);
    const invoiceDateObj = invoiceDate ? new Date(invoiceDate) : new Date();
    const dueDateObj = new Date(dueDate);

    let creationJournalId = null;
    if (expenseAccountCode && config.apControlAccountCode) {
      const journal = await AccountsPayableService._postAutomaticJournal({
        tenantId, userId,
        postingDate: invoiceDateObj,
        description: `Payable created for vendor invoice ${resolvedInvoiceNumber}`,
        currency,
        referenceNumber: resolvedInvoiceNumber,
        lines: [
          { accountCode: expenseAccountCode, debit: roundedAmount },
          { accountCode: config.apControlAccountCode, credit: roundedAmount }
        ]
      });
      creationJournalId = journal?._id || null;
    }

    const payable = await AccountsPayableModel.create({
      tenantId,
      vendorId,
      vendorName: vendor.name,
      invoiceNumber: resolvedInvoiceNumber,
      invoiceDate: invoiceDateObj,
      dueDate: dueDateObj,
      originalAmount: roundedAmount,
      paidAmount: 0,
      outstandingBalance: roundedAmount,
      currency,
      status: config.defaultPayableStatus,
      timeline: [{ event: "PayableCreated", description: `Payable created for vendor invoice ${resolvedInvoiceNumber}.`, performedBy: userId || null }],
      createdBy: userId || null,
      updatedBy: userId || null
    });

    // Auto-apply any existing vendor advance/credit against this new
    // payable. Only nudges paidAmount/outstandingBalance — status stays
    // whatever it was (Draft, typically), since applying an advance doesn't
    // itself approve the payable for payment.
    const { consumedAmount } = await VendorCreditService.consumeAvailableCredits(vendorId, tenantId, currency, payable.outstandingBalance);
    if (consumedAmount > 0) {
      payable.adjustments.push({ type: "AdvanceApplied", amount: consumedAmount, reason: "Auto-applied available vendor credit/advance.", performedBy: "system", performedAt: new Date() });
      payable.paidAmount = roundCurrency(payable.paidAmount + consumedAmount);
      payable.outstandingBalance = roundCurrency(payable.outstandingBalance - consumedAmount);
      payable.timeline.push({ event: "AdvanceApplied", description: `Vendor advance of ${consumedAmount} ${currency} applied automatically.`, performedBy: "system" });
      await payable.save();
    }

    await AuditLogModel.create({
      action: "finance.payable.create",
      module: "Finance",
      resource: "AccountsPayable",
      resourceId: payable._id.toString(),
      userId: userId || null,
      tenantId,
      details: { invoiceNumber: resolvedInvoiceNumber, originalAmount: roundedAmount, consumedAdvance: consumedAmount, creationJournalId: creationJournalId ? creationJournalId.toString() : null }
    });

    publishEvent("PayableCreated", { tenantId, payableId: payable._id.toString(), vendorId: vendorId.toString(), invoiceNumber: resolvedInvoiceNumber, originalAmount: roundedAmount, performedBy: userId || null });

    return payable.toJSON();
  }

  /**
   * POST /api/v1/accounts-payable/{payableId}/approve — gap-fill: Payable
   * Lifecycle requires clearing approval before a payable can be paid
   * (Draft/Pending Approval -> Approved -> Open), but no endpoint was
   * contracted to do it. Transitions straight to "Open" (the actual
   * payable-for-payment state) while still recording approvedBy/approvedAt
   * and firing `PayableApproved` — the spec gives no distinct trigger or
   * event between "Approved" and "Open," so they're treated as one real
   * state reached by this one action rather than leaving "Open"
   * unreachable behind a second, undefined step.
   */
  static async approvePayable(payableId, tenantId, userId) {
    const payable = await AccountsPayableModel.findOne({ _id: payableId, tenantId });
    if (!payable) throw new Error("Payable not found.");
    if (!["Draft", "Pending Approval"].includes(payable.status)) {
      throw new Error(`Payable cannot be approved from status "${payable.status}".`);
    }

    payable.status = "Open";
    payable.approvedBy = userId || null;
    payable.approvedAt = new Date();
    payable.updatedBy = userId || null;
    payable.timeline.push({ event: "PayableApproved", description: "Payable approved for payment.", performedBy: userId || null });
    await payable.save();

    await AuditLogModel.create({ action: "finance.payable.approve", module: "Finance", resource: "AccountsPayable", resourceId: payable._id.toString(), userId: userId || null, tenantId, details: {} });
    publishEvent("PayableApproved", { tenantId, payableId: payable._id.toString(), vendorId: payable.vendorId.toString(), performedBy: userId || null });

    return payable.toJSON();
  }

  /**
   * POST /api/v1/accounts-payable/{payableId}/allocate-payment
   * Validate Payment -> Validate Outstanding Balance -> Allocate Amount ->
   * Update Balance -> Generate Journal -> Update Ledger -> Timeline -> Audit
   * -> Publish VendorPaymentAllocated.
   */
  static async allocatePayment(payableId, data, tenantId, userId) {
    const config = getFinanceConfig();
    const { paymentId, amount } = data;
    if (!paymentId || !amount || amount <= 0) throw new Error("paymentId and a positive amount are required.");

    const payable = await AccountsPayableModel.findOne({ _id: payableId, tenantId });
    if (!payable) throw new Error("Payable not found.");
    if (!PAYABLE_ELIGIBLE_STATUSES.has(payable.status)) {
      throw new Error(`Cannot allocate a payment to a payable in status "${payable.status}".`);
    }

    const payment = await PaymentService.getPaymentById(paymentId, tenantId);
    if (payment.currency !== payable.currency) {
      throw new Error(`Currency mismatch: payment is ${payment.currency}, payable is ${payable.currency}.`);
    }
    // Payment Engine (Part 7) payments are independent transactions —
    // partyId is optional/informational, not guaranteed. Enforce the match
    // only when the caller actually supplied a vendor party on the payment.
    if (payment.partyType === "vendor" && payment.partyId && payment.partyId.toString() !== payable.vendorId.toString()) {
      throw new Error("Payment does not belong to this payable's vendor.");
    }

    const roundedAmount = roundCurrency(amount);
    const { appliedToBalance, overpaymentExcess } = computeOverpaymentSplit(roundedAmount, payable.outstandingBalance);

    // Ledger posting attempted BEFORE any mutation — same ordering
    // discipline as AccountsReceivableService.allocatePayment, for the same
    // reason (no multi-document transactions anywhere in this codebase).
    let journalId = null;
    if (config.defaultCashAccountCode && config.apControlAccountCode) {
      const debitLines = [{ accountCode: config.apControlAccountCode, debit: appliedToBalance }];
      let cashCredit = appliedToBalance;
      if (overpaymentExcess > 0 && config.vendorAdvanceAssetAccountCode) {
        cashCredit = roundedAmount;
        debitLines.push({ accountCode: config.vendorAdvanceAssetAccountCode, debit: overpaymentExcess });
      }
      const journal = await AccountsPayableService._postAutomaticJournal({
        tenantId, userId,
        postingDate: new Date(),
        description: `Payment allocated to payable ${payable.invoiceNumber}`,
        currency: payable.currency,
        referenceNumber: payable.invoiceNumber,
        lines: [...debitLines, { accountCode: config.defaultCashAccountCode, credit: cashCredit }]
      });
      journalId = journal?._id || null;
    }

    await PaymentService.consumeUnallocatedAmount(payment._id, tenantId, roundedAmount, { targetType: "AccountsPayable", targetId: payable._id, allocatedBy: userId });

    payable.paidAmount = roundCurrency(payable.paidAmount + appliedToBalance);
    payable.outstandingBalance = roundCurrency(payable.outstandingBalance - appliedToBalance);
    payable.allocations.push({ paymentId: payment._id, amount: roundedAmount, journalId, allocatedAt: new Date(), allocatedBy: userId || null });
    payable.status = resolveStatusAfterPayment(payable.outstandingBalance);
    payable.updatedBy = userId || null;
    payable.timeline.push({ event: "VendorPaymentAllocated", description: `Payment of ${roundedAmount} ${payable.currency} allocated.`, performedBy: userId || null });
    await payable.save();

    let credit = null;
    if (overpaymentExcess > 0) {
      credit = await VendorCreditService.createCredit({
        vendorId: payable.vendorId,
        amount: overpaymentExcess,
        currency: payable.currency,
        source: "Overpayment",
        sourceReferenceId: payable._id
      }, tenantId, userId);
    }

    await AuditLogModel.create({
      action: "finance.payable.allocate_payment",
      module: "Finance",
      resource: "AccountsPayable",
      resourceId: payable._id.toString(),
      userId: userId || null,
      tenantId,
      details: { paymentId: paymentId.toString(), amount: roundedAmount, appliedToBalance, overpaymentExcess }
    });

    publishEvent("VendorPaymentAllocated", { tenantId, payableId: payable._id.toString(), vendorId: payable.vendorId.toString(), paymentId: paymentId.toString(), amount: roundedAmount, appliedToBalance, overpaymentExcess, performedBy: userId || null });
    if (payable.status === "Paid") {
      publishEvent("PayablePaid", { tenantId, payableId: payable._id.toString(), vendorId: payable.vendorId.toString(), performedBy: userId || null });
    }
    if (payable.outstandingBalance <= 0) {
      publishEvent("VendorSettlementCompleted", { tenantId, payableId: payable._id.toString(), vendorId: payable.vendorId.toString(), settledVia: "Payment", performedBy: userId || null });
    }

    return { payable: payable.toJSON(), credit };
  }

  /**
   * POST /api/v1/accounts-payable/{payableId}/write-off — gap-fill, mirrors
   * AR's write-off. Ledger direction is the mirror-opposite of AR's:
   * forgiving a liability is a gain, so this credits an income account, not
   * an expense one.
   */
  static async writeOff(payableId, data, tenantId, userId) {
    const config = getFinanceConfig();
    const { writeOffType, reason = null } = data;
    if (!writeOffType) throw new Error("writeOffType is required.");

    const payable = await AccountsPayableModel.findOne({ _id: payableId, tenantId });
    if (!payable) throw new Error("Payable not found.");
    if (TERMINAL_STATUSES.has(payable.status)) {
      throw new Error(`Cannot write off a payable in status "${payable.status}".`);
    }
    if (payable.outstandingBalance <= 0) throw new Error("Payable has no outstanding balance to write off.");

    const amount = payable.outstandingBalance;

    let journalId = null;
    if (config.apControlAccountCode && config.vendorWaiverIncomeAccountCode) {
      const journal = await AccountsPayableService._postAutomaticJournal({
        tenantId, userId,
        postingDate: new Date(),
        description: `Write-off (${writeOffType}) for payable ${payable.invoiceNumber}`,
        currency: payable.currency,
        referenceNumber: payable.invoiceNumber,
        lines: [
          { accountCode: config.apControlAccountCode, debit: amount },
          { accountCode: config.vendorWaiverIncomeAccountCode, credit: amount }
        ]
      });
      journalId = journal?._id || null;
    }

    payable.adjustments.push({ type: "WriteOff", amount, reason, performedBy: userId || null, performedAt: new Date() });
    payable.outstandingBalance = 0;
    payable.status = "Written Off";
    payable.writeOff = { isWrittenOff: true, writeOffType, reason, approvedBy: userId || null, approvedAt: new Date(), journalId };
    payable.updatedBy = userId || null;
    payable.timeline.push({ event: "PayableWrittenOff", description: `Written off (${writeOffType})${reason ? `: ${reason}` : ""}.`, performedBy: userId || null });
    await payable.save();

    await AuditLogModel.create({
      action: "finance.payable.write_off",
      module: "Finance",
      resource: "AccountsPayable",
      resourceId: payable._id.toString(),
      userId: userId || null,
      tenantId,
      details: { writeOffType, amount, reason }
    });

    publishEvent("PayableWrittenOff", { tenantId, payableId: payable._id.toString(), vendorId: payable.vendorId.toString(), writeOffType, amount, performedBy: userId || null });
    publishEvent("VendorSettlementCompleted", { tenantId, payableId: payable._id.toString(), vendorId: payable.vendorId.toString(), settledVia: "WriteOff", performedBy: userId || null });

    return payable.toJSON();
  }

  /**
   * POST /api/v1/accounts-payable/{payableId}/schedule-payment — gap-fill:
   * `VendorPaymentScheduled` is a named domain event with no endpoint to
   * reach it. Planning/visibility metadata only (see utils/financeConfig.js
   * paymentPriorities doc comment) — does not execute a payment.
   */
  static async schedulePayment(payableId, data, tenantId, userId) {
    const config = getFinanceConfig();
    const { scheduledDate, priority } = data;
    if (!scheduledDate || !priority) throw new Error("scheduledDate and priority are required.");
    if (!config.paymentPriorities.includes(priority)) throw new Error(`Invalid priority "${priority}".`);

    const payable = await AccountsPayableModel.findOne({ _id: payableId, tenantId });
    if (!payable) throw new Error("Payable not found.");
    if (TERMINAL_STATUSES.has(payable.status)) {
      throw new Error(`Cannot schedule payment for a payable in status "${payable.status}".`);
    }

    payable.scheduledPayment = { date: new Date(scheduledDate), priority };
    payable.updatedBy = userId || null;
    payable.timeline.push({ event: "VendorPaymentScheduled", description: `Payment scheduled for ${scheduledDate} (${priority}).`, performedBy: userId || null });
    await payable.save();

    await AuditLogModel.create({ action: "finance.payable.schedule_payment", module: "Finance", resource: "AccountsPayable", resourceId: payable._id.toString(), userId: userId || null, tenantId, details: { scheduledDate, priority } });
    publishEvent("VendorPaymentScheduled", { tenantId, payableId: payable._id.toString(), vendorId: payable.vendorId.toString(), scheduledDate, priority, performedBy: userId || null });

    return payable.toJSON();
  }

  /**
   * Called by DebitNoteService.allocateDebitNote (Part 11) — increases the
   * payable's outstanding balance by the debit note's grandTotal. Mirror of
   * AccountsReceivableService.applyDebitNote; see that method's doc comment
   * for why "Paid" is deliberately not blocked here.
   */
  static async applyDebitNote(payableId, { amount, debitNoteId, reason = null }, tenantId, userId) {
    const payable = await AccountsPayableModel.findOne({ _id: payableId, tenantId });
    if (!payable) throw new Error("Payable not found.");
    if (DEBIT_NOTE_BLOCKED_STATUSES.has(payable.status)) {
      throw new Error(`Cannot apply a debit note to a payable in status "${payable.status}".`);
    }

    const roundedAmount = roundCurrency(amount);
    if (roundedAmount <= 0) throw new Error("Debit note amount must be greater than zero.");

    payable.outstandingBalance = roundCurrency(payable.outstandingBalance + roundedAmount);
    payable.adjustments.push({ type: "DebitNoteApplied", amount: roundedAmount, reason, performedBy: userId || null, performedAt: new Date() });
    payable.debitNoteIds.push(debitNoteId);
    if (payable.status === "Paid") payable.status = "Partially Paid";
    payable.updatedBy = userId || null;
    payable.timeline.push({ event: "DebitNoteApplied", description: `Debit note applied: ${roundedAmount} ${payable.currency}.`, performedBy: userId || null });
    await payable.save();

    await AuditLogModel.create({
      action: "finance.payable.apply_debit_note",
      module: "Finance",
      resource: "AccountsPayable",
      resourceId: payable._id.toString(),
      userId: userId || null,
      tenantId,
      details: { debitNoteId: debitNoteId.toString(), amount: roundedAmount }
    });

    publishEvent("OutstandingBalanceIncreased", { tenantId, payableId: payable._id.toString(), vendorId: payable.vendorId.toString(), debitNoteId: debitNoteId.toString(), amount: roundedAmount, performedBy: userId || null });

    return payable.toJSON();
  }

  /** Shared by createPayable/allocatePayment/writeOff — see JournalService._postAutomaticJournal's twin in AccountsReceivableService for the approve-before-post reasoning. */
  static async _postAutomaticJournal({ tenantId, userId, postingDate, description, currency, referenceNumber, lines }) {
    const journal = await JournalService.createJournal({
      journalType: "Automatic",
      postingDate,
      description,
      referenceNumber,
      currency,
      lines
    }, tenantId, userId || "system");
    await JournalService.approveJournal(journal._id, tenantId, userId || "system");
    return JournalService.postJournal(journal._id, tenantId, userId || "system");
  }
}

export default AccountsPayableService;
