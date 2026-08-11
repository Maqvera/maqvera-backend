import mongoose from "mongoose";
import AccountsReceivableModel from "../models/AccountsReceivableModel.js";
import CustomerModel from "../models/CustomerModel.js";
import CustomerCreditProfileModel from "../models/CustomerCreditProfileModel.js";
import AuditLogModel from "../models/AuditLogmodel.js";
import PaymentService from "./PaymentService.js";
import CustomerCreditService from "./CustomerCreditService.js";
import JournalService from "./JournalService.js";
import FinanceSequenceModel from "../models/FinanceSequenceModel.js";
import { subscribeEvent, publishEvent } from "../utils/eventBus.js";
import { getFinanceConfig } from "../utils/financeConfig.js";
import { computeAgingBucket } from "../utils/agingUtils.js";
import { computeOverpaymentSplit, resolveStatusAfterPayment } from "../utils/paymentAllocationUtils.js";

const roundCurrency = (value) => Math.round((Number(value) || 0) * 100) / 100;

// ---------------------------------------------------------------------------
// Pure helpers — no DB access, unit-testable directly (see
// tests/accountsReceivableService.test.js). computeAgingBucket and
// computeOverpaymentSplit/resolveStatusAfterPayment are shared with
// Accounts Payable (identical math in both directions) — see
// utils/agingUtils.js / utils/paymentAllocationUtils.js. Re-exported here
// so existing imports/tests of this module keep working unchanged.
// ---------------------------------------------------------------------------

export { computeAgingBucket, computeOverpaymentSplit, resolveStatusAfterPayment };

/**
 * "Credit Limit... Automatic validation before new invoices." A
 * `creditLimit` of 0 (unconfigured) means unlimited — no check performed.
 */
export const assertWithinCreditLimit = (creditLimit, creditUsed, newAmount, enforcement = true) => {
  if (!enforcement) return;
  if (!creditLimit || creditLimit <= 0) return;
  const projected = roundCurrency(creditUsed + newAmount);
  if (projected > creditLimit) {
    throw new Error(`Credit limit exceeded: this receivable would bring the customer's used credit to ${projected}, exceeding their limit of ${creditLimit}.`);
  }
};

// Receivable statuses that never accept a payment allocation or write-off.
const TERMINAL_STATUSES = new Set(["Paid", "Settled", "Written Off", "Cancelled"]);
// A Debit Note's entire purpose is to reopen an already-settled receivable
// and charge more — "Paid" is deliberately NOT in this set (unlike
// TERMINAL_STATUSES above). Only genuine dead ends — a forgiven or
// cancelled obligation — block it. See applyDebitNote below.
const DEBIT_NOTE_BLOCKED_STATUSES = new Set(["Written Off", "Cancelled"]);

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

class AccountsReceivableService {
  /**
   * Wires the Part 1 "Integration Strategy" (business modules publish
   * events; Finance consumes them) for the Invoice -> Receivable handoff.
   * No Invoice module exists yet (Part 7), so this listener is dormant
   * today — it starts working the moment that module publishes
   * InvoiceCreated, with zero changes needed here. Call once from
   * server.js's bootstrap, same convention as CustomerTimelineEventBus.init().
   */
  static _eventListenersInitialized = false;
  static initEventListeners() {
    if (AccountsReceivableService._eventListenersInitialized) return;
    AccountsReceivableService._eventListenersInitialized = true;

    subscribeEvent("InvoiceCreated", async (payload) => {
      if (!payload?.tenantId || !payload?.customerId || !payload?.invoiceNumber || !payload?.amount) return;
      try {
        await AccountsReceivableService.createReceivable({
          customerId: payload.customerId,
          invoiceId: payload.invoiceId || null,
          invoiceNumber: payload.invoiceNumber,
          issueDate: payload.issueDate || new Date(),
          dueDate: payload.dueDate,
          originalAmount: payload.amount,
          currency: payload.currency,
          revenueAccountCode: payload.revenueAccountCode || null
        }, payload.tenantId, payload.performedBy || "system");
      } catch (error) {
        // A malformed/duplicate InvoiceCreated event must not crash the
        // publisher's request — same non-blocking contract as every other
        // eventBus listener (utils/eventBus.js already isolates listener
        // failures via Promise.allSettled).
        console.error("AccountsReceivableService.InvoiceCreated handler failed:", error.message);
      }
    });
  }

  static async _resolveInvoiceNumber(tenantId, invoiceNumber) {
    if (invoiceNumber) return invoiceNumber;
    const year = `${new Date().getUTCFullYear()}`;
    const seq = await FinanceSequenceModel.getNext(tenantId, "receivableManualNumber", year);
    return `AR-${year}-${String(seq).padStart(6, "0")}`;
  }

  static async getCreditUsed(customerId, tenantId) {
    const [result] = await AccountsReceivableModel.aggregate([
      { $match: { tenantId, customerId: new mongoose.Types.ObjectId(customerId), status: { $nin: [...TERMINAL_STATUSES] } } },
      { $group: { _id: null, total: { $sum: "$outstandingBalance" } } }
    ]);
    return roundCurrency(result?.total || 0);
  }

  static _decorate(receivable, referenceDate = new Date()) {
    const config = getFinanceConfig();
    const { label, daysOverdue } = computeAgingBucket(receivable.dueDate, referenceDate, config.agingBuckets);
    return { ...receivable, agingBucket: label, daysOverdue };
  }

  /**
   * GET /api/v1/accounts-receivable
   */
  static async listReceivables(query, tenantId) {
    const config = getFinanceConfig();
    const { customerId, status, currency, overdue, sort } = query;

    const filter = { tenantId };
    if (customerId) filter.customerId = customerId;
    if (status) filter.status = status;
    if (currency) filter.currency = currency;
    if (query.dueDateFrom || query.dueDateTo) {
      filter.dueDate = {};
      if (query.dueDateFrom) filter.dueDate.$gte = new Date(query.dueDateFrom);
      if (query.dueDateTo) filter.dueDate.$lte = new Date(query.dueDateTo);
    }
    if (overdue === "true" || overdue === true) {
      filter.dueDate = { ...(filter.dueDate || {}), $lt: new Date() };
      filter.status = { $in: ["Open", "Partially Paid", "Overdue", "In Collection"] };
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
      AccountsReceivableModel.find(filter).sort(sortSpec).skip(skip).limit(pageSize).lean(),
      AccountsReceivableModel.countDocuments(filter)
    ]);

    const now = new Date();
    return { items: items.map((item) => AccountsReceivableService._decorate(item, now)), pagination: { total, page, pageSize, totalPages: Math.ceil(total / pageSize) } };
  }

  /**
   * GET /api/v1/accounts-receivable/{receivableId}
   */
  static async getReceivableById(receivableId, tenantId) {
    const receivable = await AccountsReceivableModel.findOne({ _id: receivableId, tenantId }).lean();
    if (!receivable) throw new Error("Receivable not found.");

    const auditSummary = await AuditLogModel.find({
      tenantId,
      resource: "AccountsReceivable",
      resourceId: receivable._id.toString()
    }).sort({ createdAt: -1 }).limit(20).lean();

    return { ...AccountsReceivableService._decorate(receivable), auditSummary };
  }

  /**
   * Gap-fill: no "create receivable" endpoint was contracted (Part 5 only
   * gives list/get/allocate-payment), but the module can't function at all
   * without one, and no Invoice module exists yet to trigger
   * InvoiceCreated. `revenueAccountCode` is this endpoint's own field (not
   * in the spec) so a real creation-time journal (Debit AR / Credit
   * Revenue — Part 1's own worked example) can post when the caller
   * supplies it; omit it to skip that posting.
   */
  static async createReceivable(data, tenantId, userId) {
    const config = getFinanceConfig();
    const { customerId, invoiceId = null, invoiceNumber, issueDate, dueDate, originalAmount, currency, revenueAccountCode = null } = data;

    if (!customerId || !dueDate || !originalAmount || !currency) {
      throw new Error("customerId, dueDate, originalAmount, and currency are required.");
    }

    const customer = await CustomerModel.findOne({ _id: customerId, tenantId }).lean();
    if (!customer) throw new Error("Customer not found.");

    const roundedAmount = roundCurrency(originalAmount);

    const profile = await CustomerCreditProfileModel.findOne({ tenantId, customerId }).lean();
    if (profile) {
      const creditUsed = await AccountsReceivableService.getCreditUsed(customerId, tenantId);
      assertWithinCreditLimit(profile.creditLimit, creditUsed, roundedAmount, config.creditLimitEnforcement);
    }

    const resolvedInvoiceNumber = await AccountsReceivableService._resolveInvoiceNumber(tenantId, invoiceNumber);
    const issueDateObj = issueDate ? new Date(issueDate) : new Date();
    const dueDateObj = new Date(dueDate);

    let creationJournalId = null;
    if (revenueAccountCode && config.arControlAccountCode) {
      const journal = await AccountsReceivableService._postAutomaticJournal({
        tenantId, userId,
        postingDate: issueDateObj,
        description: `Receivable created for invoice ${resolvedInvoiceNumber}`,
        currency,
        referenceNumber: resolvedInvoiceNumber,
        lines: [
          { accountCode: config.arControlAccountCode, debit: roundedAmount },
          { accountCode: revenueAccountCode, credit: roundedAmount }
        ]
      });
      creationJournalId = journal?._id || null;
    }

    const receivable = await AccountsReceivableModel.create({
      tenantId,
      customerId,
      customerName: `${customer.firstName || ""} ${customer.lastName || ""}`.trim() || customer.companyName || "Customer",
      invoiceId,
      invoiceNumber: resolvedInvoiceNumber,
      issueDate: issueDateObj,
      dueDate: dueDateObj,
      originalAmount: roundedAmount,
      paidAmount: 0,
      outstandingBalance: roundedAmount,
      currency,
      status: config.defaultReceivableStatus,
      timeline: [{ event: "ReceivableCreated", description: `Receivable created for invoice ${resolvedInvoiceNumber}.`, performedBy: userId || null }],
      createdBy: userId || null,
      updatedBy: userId || null
    });

    await AuditLogModel.create({
      action: "finance.receivable.create",
      module: "Finance",
      resource: "AccountsReceivable",
      resourceId: receivable._id.toString(),
      userId: userId || null,
      tenantId,
      details: { invoiceNumber: resolvedInvoiceNumber, originalAmount: roundedAmount, creationJournalId: creationJournalId ? creationJournalId.toString() : null }
    });

    publishEvent("ReceivableCreated", { tenantId, receivableId: receivable._id.toString(), customerId: customerId.toString(), invoiceNumber: resolvedInvoiceNumber, originalAmount: roundedAmount, performedBy: userId || null });

    // "Customer Credit Wallet... Reusable across invoices" (Part 10) —
    // auto-apply any existing Active CustomerCredit for this customer
    // against the new receivable, mirroring AP's exact
    // consumeAvailableCredits pattern (used since Part 6). Previously
    // deferred here (see CustomerCreditModel.remainingAmount's own doc
    // comment) for lack of a concrete endpoint/event to build against —
    // Part 10 names one (`CreditApplied`), completing it now.
    const { consumedAmount } = await CustomerCreditService.consumeAvailableCredits(customerId, tenantId, currency, receivable.outstandingBalance);
    if (consumedAmount > 0) {
      receivable.adjustments.push({ type: "CreditApplied", amount: consumedAmount, reason: "Auto-applied available customer credit.", performedBy: "system", performedAt: new Date() });
      receivable.paidAmount = roundCurrency(receivable.paidAmount + consumedAmount);
      receivable.outstandingBalance = roundCurrency(receivable.outstandingBalance - consumedAmount);
      receivable.status = resolveStatusAfterPayment(receivable.outstandingBalance);
      receivable.timeline.push({ event: "CreditApplied", description: `Existing customer credit of ${consumedAmount} ${currency} applied automatically.`, performedBy: "system" });
      await receivable.save();
      publishEvent("CreditApplied", { tenantId, receivableId: receivable._id.toString(), customerId: customerId.toString(), amount: consumedAmount, performedBy: "system" });
    }

    return receivable.toJSON();
  }

  /**
   * POST /api/v1/accounts-receivable/{receivableId}/allocate-payment
   * Validate Payment -> Validate Outstanding Balance -> Allocate Amount ->
   * Update Balance -> Generate Journal -> Update Ledger -> Timeline -> Audit
   * -> Publish PaymentAllocated.
   */
  static async allocatePayment(receivableId, data, tenantId, userId) {
    const config = getFinanceConfig();
    const { paymentId, amount } = data;
    if (!paymentId || !amount || amount <= 0) throw new Error("paymentId and a positive amount are required.");

    const receivable = await AccountsReceivableModel.findOne({ _id: receivableId, tenantId });
    if (!receivable) throw new Error("Receivable not found.");
    if (TERMINAL_STATUSES.has(receivable.status)) {
      throw new Error(`Cannot allocate a payment to a receivable in status "${receivable.status}".`);
    }

    const payment = await PaymentService.getPaymentById(paymentId, tenantId);
    if (payment.currency !== receivable.currency) {
      throw new Error(`Currency mismatch: payment is ${payment.currency}, receivable is ${receivable.currency}.`);
    }
    // Payment Engine (Part 7) payments are independent transactions —
    // partyId is optional/informational, not guaranteed. Enforce the match
    // only when the caller actually supplied a customer party on the
    // payment; otherwise there's nothing to check against.
    if (payment.partyType === "customer" && payment.partyId && payment.partyId.toString() !== receivable.customerId.toString()) {
      throw new Error("Payment does not belong to this receivable's customer.");
    }

    const roundedAmount = roundCurrency(amount);
    const { appliedToBalance: appliedToReceivable, overpaymentExcess } = computeOverpaymentSplit(roundedAmount, receivable.outstandingBalance);

    // Ledger posting attempted BEFORE any mutation (payment/receivable) so a
    // closed financial period or account-configuration problem fails the
    // whole request cleanly rather than leaving inconsistent state — this
    // codebase has no multi-document transactions anywhere (see
    // services/LedgerService.js), so ordering is the only safety net.
    let journalId = null;
    if (config.defaultCashAccountCode && config.arControlAccountCode) {
      const creditLines = [{ accountCode: config.arControlAccountCode, credit: appliedToReceivable }];
      let cashDebit = appliedToReceivable;
      if (overpaymentExcess > 0 && config.customerCreditLiabilityAccountCode) {
        cashDebit = roundedAmount;
        creditLines.push({ accountCode: config.customerCreditLiabilityAccountCode, credit: overpaymentExcess });
      }
      const journal = await AccountsReceivableService._postAutomaticJournal({
        tenantId, userId,
        postingDate: new Date(),
        description: `Payment allocated to receivable ${receivable.invoiceNumber}`,
        currency: receivable.currency,
        referenceNumber: receivable.invoiceNumber,
        lines: [{ accountCode: config.defaultCashAccountCode, debit: cashDebit }, ...creditLines]
      });
      journalId = journal?._id || null;
    }

    await PaymentService.consumeUnallocatedAmount(payment._id, tenantId, roundedAmount, { targetType: "AccountsReceivable", targetId: receivable._id, allocatedBy: userId });

    receivable.paidAmount = roundCurrency(receivable.paidAmount + appliedToReceivable);
    receivable.outstandingBalance = roundCurrency(receivable.outstandingBalance - appliedToReceivable);
    receivable.allocations.push({ paymentId: payment._id, amount: roundedAmount, journalId, allocatedAt: new Date(), allocatedBy: userId || null });
    receivable.status = resolveStatusAfterPayment(receivable.outstandingBalance);
    receivable.updatedBy = userId || null;
    receivable.timeline.push({ event: "PaymentAllocated", description: `Payment of ${roundedAmount} ${receivable.currency} allocated.`, performedBy: userId || null });
    await receivable.save();

    let credit = null;
    if (overpaymentExcess > 0) {
      credit = await CustomerCreditService.createCredit({
        customerId: receivable.customerId,
        amount: overpaymentExcess,
        currency: receivable.currency,
        source: "Overpayment",
        sourceReferenceId: receivable._id
      }, tenantId, userId);
    }

    await AuditLogModel.create({
      action: "finance.receivable.allocate_payment",
      module: "Finance",
      resource: "AccountsReceivable",
      resourceId: receivable._id.toString(),
      userId: userId || null,
      tenantId,
      details: { paymentId: paymentId.toString(), amount: roundedAmount, appliedToReceivable, overpaymentExcess }
    });

    publishEvent("PaymentAllocated", { tenantId, receivableId: receivable._id.toString(), customerId: receivable.customerId.toString(), paymentId: paymentId.toString(), amount: roundedAmount, appliedToReceivable, overpaymentExcess, performedBy: userId || null });
    if (receivable.status === "Paid") {
      publishEvent("ReceivablePaid", { tenantId, receivableId: receivable._id.toString(), customerId: receivable.customerId.toString(), performedBy: userId || null });
    }
    if (receivable.outstandingBalance <= 0) {
      publishEvent("ReceivableSettled", { tenantId, receivableId: receivable._id.toString(), customerId: receivable.customerId.toString(), settledVia: "Payment", performedBy: userId || null });
    }

    return { receivable: receivable.toJSON(), credit };
  }

  /**
   * POST /api/v1/accounts-receivable/{receivableId}/write-off
   * Gap-fill: the spec's own Lifecycle diagram and Domain Events list name
   * "Written Off" / `ReceivableWrittenOff`, but no endpoint was contracted
   * to reach them. "Management Approval" is enforced via the
   * `finance.receivable.writeoff` permission gate rather than a separate
   * multi-step approval flow (same pattern as Journal's approval gate).
   */
  static async writeOff(receivableId, data, tenantId, userId) {
    const config = getFinanceConfig();
    const { writeOffType, reason = null } = data;
    if (!writeOffType) throw new Error("writeOffType is required.");

    const receivable = await AccountsReceivableModel.findOne({ _id: receivableId, tenantId });
    if (!receivable) throw new Error("Receivable not found.");
    if (TERMINAL_STATUSES.has(receivable.status)) {
      throw new Error(`Cannot write off a receivable in status "${receivable.status}".`);
    }
    if (receivable.outstandingBalance <= 0) throw new Error("Receivable has no outstanding balance to write off.");

    const amount = receivable.outstandingBalance;

    let journalId = null;
    if (config.arControlAccountCode && config.badDebtExpenseAccountCode) {
      const journal = await AccountsReceivableService._postAutomaticJournal({
        tenantId, userId,
        postingDate: new Date(),
        description: `Write-off (${writeOffType}) for receivable ${receivable.invoiceNumber}`,
        currency: receivable.currency,
        referenceNumber: receivable.invoiceNumber,
        lines: [
          { accountCode: config.badDebtExpenseAccountCode, debit: amount },
          { accountCode: config.arControlAccountCode, credit: amount }
        ]
      });
      journalId = journal?._id || null;
    }

    receivable.adjustments.push({ type: "WriteOff", amount, reason, performedBy: userId || null, performedAt: new Date() });
    receivable.outstandingBalance = 0;
    receivable.status = "Written Off";
    receivable.writeOff = { isWrittenOff: true, writeOffType, reason, approvedBy: userId || null, approvedAt: new Date(), journalId };
    receivable.updatedBy = userId || null;
    receivable.timeline.push({ event: "ReceivableWrittenOff", description: `Written off (${writeOffType})${reason ? `: ${reason}` : ""}.`, performedBy: userId || null });
    await receivable.save();

    await AuditLogModel.create({
      action: "finance.receivable.write_off",
      module: "Finance",
      resource: "AccountsReceivable",
      resourceId: receivable._id.toString(),
      userId: userId || null,
      tenantId,
      details: { writeOffType, amount, reason }
    });

    publishEvent("ReceivableWrittenOff", { tenantId, receivableId: receivable._id.toString(), customerId: receivable.customerId.toString(), writeOffType, amount, performedBy: userId || null });
    publishEvent("ReceivableSettled", { tenantId, receivableId: receivable._id.toString(), customerId: receivable.customerId.toString(), settledVia: "WriteOff", performedBy: userId || null });

    return receivable.toJSON();
  }

  /**
   * Called by CreditNoteService.issue (Part 10) — reduces the receivable's
   * outstanding balance by the credit note's grandTotal. Reuses the exact
   * same overpayment-split math as allocatePayment: a credit note is
   * conceptually "negative money owed," so if it credits MORE than what's
   * still outstanding (because the invoice was already partially/fully
   * paid), the excess becomes real Customer Credit rather than driving the
   * balance negative — identical reasoning to a cash overpayment.
   */
  static async applyCreditNote(receivableId, { amount, creditNoteId, reason = null }, tenantId, userId) {
    const receivable = await AccountsReceivableModel.findOne({ _id: receivableId, tenantId });
    if (!receivable) throw new Error("Receivable not found.");
    if (TERMINAL_STATUSES.has(receivable.status)) {
      throw new Error(`Cannot apply a credit note to a receivable in status "${receivable.status}".`);
    }

    const roundedAmount = roundCurrency(amount);
    if (roundedAmount <= 0) throw new Error("Credit note amount must be greater than zero.");
    const { appliedToBalance, overpaymentExcess: excessToCredit } = computeOverpaymentSplit(roundedAmount, receivable.outstandingBalance);

    receivable.outstandingBalance = roundCurrency(receivable.outstandingBalance - appliedToBalance);
    receivable.adjustments.push({ type: "CreditNoteApplied", amount: roundedAmount, reason, performedBy: userId || null, performedAt: new Date() });
    receivable.creditNoteIds.push(creditNoteId);
    receivable.status = resolveStatusAfterPayment(receivable.outstandingBalance);
    receivable.updatedBy = userId || null;
    receivable.timeline.push({ event: "CreditNoteApplied", description: `Credit note applied: ${roundedAmount} ${receivable.currency}.`, performedBy: userId || null });
    await receivable.save();

    let credit = null;
    if (excessToCredit > 0) {
      credit = await CustomerCreditService.createCredit({
        customerId: receivable.customerId,
        amount: excessToCredit,
        currency: receivable.currency,
        source: "CreditNote",
        sourceReferenceId: creditNoteId
      }, tenantId, userId);
    }

    await AuditLogModel.create({
      action: "finance.receivable.apply_credit_note",
      module: "Finance",
      resource: "AccountsReceivable",
      resourceId: receivable._id.toString(),
      userId: userId || null,
      tenantId,
      details: { creditNoteId: creditNoteId.toString(), amount: roundedAmount, appliedToBalance, excessToCredit }
    });

    publishEvent("CreditNoteAllocated", { tenantId, receivableId: receivable._id.toString(), customerId: receivable.customerId.toString(), creditNoteId: creditNoteId.toString(), amount: roundedAmount, appliedToBalance, excessToCredit, performedBy: userId || null });
    if (receivable.outstandingBalance <= 0) {
      publishEvent("ReceivableSettled", { tenantId, receivableId: receivable._id.toString(), customerId: receivable.customerId.toString(), settledVia: "CreditNote", performedBy: userId || null });
    }

    return { receivable: receivable.toJSON(), credit };
  }

  /**
   * Called by DebitNoteService.allocateDebitNote (Part 11) — increases the
   * receivable's outstanding balance by the debit note's grandTotal. The
   * mirror-opposite of applyCreditNote above: there is no "excess" to
   * split off, since increasing an obligation has no ceiling (the spec's
   * own Validation Rules list names no cap for a debit note, unlike a
   * credit note's invoice-total cap) — the full amount always applies
   * straight to the balance. Uses DEBIT_NOTE_BLOCKED_STATUSES, not
   * TERMINAL_STATUSES — see that set's doc comment above for why "Paid"
   * must remain reachable here.
   */
  static async applyDebitNote(receivableId, { amount, debitNoteId, reason = null }, tenantId, userId) {
    const receivable = await AccountsReceivableModel.findOne({ _id: receivableId, tenantId });
    if (!receivable) throw new Error("Receivable not found.");
    if (DEBIT_NOTE_BLOCKED_STATUSES.has(receivable.status)) {
      throw new Error(`Cannot apply a debit note to a receivable in status "${receivable.status}".`);
    }

    const roundedAmount = roundCurrency(amount);
    if (roundedAmount <= 0) throw new Error("Debit note amount must be greater than zero.");

    receivable.outstandingBalance = roundCurrency(receivable.outstandingBalance + roundedAmount);
    receivable.adjustments.push({ type: "DebitNoteApplied", amount: roundedAmount, reason, performedBy: userId || null, performedAt: new Date() });
    receivable.debitNoteIds.push(debitNoteId);
    // Reopens a fully-paid receivable back into an actionable state — the
    // increased balance is unpaid, so "Paid" is no longer accurate.
    if (receivable.status === "Paid") receivable.status = "Partially Paid";
    receivable.updatedBy = userId || null;
    receivable.timeline.push({ event: "DebitNoteApplied", description: `Debit note applied: ${roundedAmount} ${receivable.currency}.`, performedBy: userId || null });
    await receivable.save();

    await AuditLogModel.create({
      action: "finance.receivable.apply_debit_note",
      module: "Finance",
      resource: "AccountsReceivable",
      resourceId: receivable._id.toString(),
      userId: userId || null,
      tenantId,
      details: { debitNoteId: debitNoteId.toString(), amount: roundedAmount }
    });

    publishEvent("OutstandingBalanceIncreased", { tenantId, receivableId: receivable._id.toString(), customerId: receivable.customerId.toString(), debitNoteId: debitNoteId.toString(), amount: roundedAmount, performedBy: userId || null });

    return receivable.toJSON();
  }

  /**
   * Shared by createReceivable/allocatePayment/writeOff — builds, validates,
   * and immediately posts a system-generated journal.
   *
   * A freshly created journal always starts `Draft` (JournalService.createJournal
   * doesn't take a status override), and JournalService.postJournal requires
   * `Approved` whenever JOURNAL_APPROVAL_REQUIRED is true (the default) — so
   * an "Automatic" journal is routed through the same approve step a human
   * journal would take, just performed by the system on the triggering
   * user's behalf. This keeps the full Draft -> Approved -> Posted audit
   * trail intact rather than silently bypassing the state machine.
   */
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

export default AccountsReceivableService;
