import CreditNoteModel from "../models/CreditNoteModel.js";
import InvoiceModel from "../models/InvoiceModel.js";
import CustomerModel from "../models/CustomerModel.js";
import AccountsReceivableModel from "../models/AccountsReceivableModel.js";
import AccountsReceivableService from "./AccountsReceivableService.js";
import JournalService from "./JournalService.js";
import FinancialPeriodService from "./FinancialPeriodService.js";
import FinanceSequenceModel from "../models/FinanceSequenceModel.js";
import AuditLogModel from "../models/AuditLogmodel.js";
import CreditNotePdfService from "./CreditNotePdfService.js";
import TaxService from "./TaxService.js";
import { storeDocumentPdf } from "../utils/documentPdfStorage.js";
import { publishEvent } from "../utils/eventBus.js";
import { getFinanceConfig } from "../utils/financeConfig.js";
import { resolveTaxRate } from "./InvoiceService.js";

const roundCurrency = (value) => Math.round((Number(value) || 0) * 100) / 100;

// ---------------------------------------------------------------------------
// Pure helpers — no DB access, unit-testable directly (see
// tests/creditNoteService.test.js).
// ---------------------------------------------------------------------------

/**
 * "Tax Adjustments: Automatic recalculation." Tax is recalculated for real
 * against the ORIGINAL invoice line's taxCode/rate (not caller-supplied) —
 * the caller only supplies the credit `amount` (before tax), matching the
 * spec's own request example (`{invoiceLineId, quantity, amount}`).
 */
export const computeCreditLineTotals = (item, invoiceLine, taxCodes) => {
  const amount = roundCurrency(Number(item.amount));
  if (!(amount > 0)) throw new Error(`Credit line for "${invoiceLine.description}": amount must be greater than zero.`);
  if (!(Number(item.quantity) > 0)) throw new Error(`Credit line for "${invoiceLine.description}": quantity must be greater than zero.`);

  const taxCode = invoiceLine.taxCode || null;
  const rate = resolveTaxRate(taxCode, taxCodes);
  const taxAdjustment = roundCurrency(amount * rate);
  const lineTotal = roundCurrency(amount + taxAdjustment);

  return {
    invoiceLineId: invoiceLine._id,
    description: invoiceLine.description,
    quantity: Number(item.quantity),
    amount,
    taxCode,
    taxAdjustment,
    lineTotal
  };
};

/** Sums computed credit line items into credit-note-level totals. */
export const computeCreditNoteTotals = (computedItems) => {
  const creditAmount = roundCurrency(computedItems.reduce((sum, i) => sum + i.amount, 0));
  const taxAdjustmentTotal = roundCurrency(computedItems.reduce((sum, i) => sum + i.taxAdjustment, 0));
  const grandTotal = roundCurrency(computedItems.reduce((sum, i) => sum + i.lineTotal, 0));
  return { creditAmount, taxAdjustmentTotal, grandTotal };
};

/**
 * "Validate Remaining Credit" — an invoice's total creditable capacity is
 * its own grandTotal minus every credit note already issued against it
 * (Issued/Allocated/Closed — i.e. ones that passed the issue gate; Draft/
 * Pending Approval/Approved/Cancelled/Voided don't count, so concurrent
 * drafts don't needlessly block each other — re-validated again at issue
 * time, same "validate now, re-validate at the point it matters" discipline
 * as Journal/Invoice's period-open re-checks).
 */
export const computeRemainingCreditable = (invoiceGrandTotal, priorIssuedCreditTotal) => roundCurrency(invoiceGrandTotal - priorIssuedCreditTotal);

const APPROVABLE_STATUSES = new Set(["Draft", "Pending Approval"]);
const CANCELLABLE_STATUSES = new Set(["Draft", "Pending Approval", "Approved"]);
const VOIDABLE_STATUSES = new Set(["Issued"]);
const CLOSEABLE_STATUSES = new Set(["Allocated"]);
const COUNTS_AGAINST_CAP_STATUSES = new Set(["Issued", "Allocated", "Closed"]);

export const isCreditNoteApprovable = (status) => APPROVABLE_STATUSES.has(status);
export const isCreditNoteIssuable = (status, approvalRequired) => (approvalRequired ? status === "Approved" : status === "Draft" || status === "Approved");
export const isCreditNoteAllocatable = (status) => status === "Issued";
export const isCreditNoteCancellable = (status) => CANCELLABLE_STATUSES.has(status);
export const isCreditNoteVoidable = (status) => VOIDABLE_STATUSES.has(status);
export const isCreditNoteCloseable = (status) => CLOSEABLE_STATUSES.has(status);

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

class CreditNoteService {
  static async _generateCreditNumber(tenantId) {
    const config = getFinanceConfig();
    const year = `${new Date().getUTCFullYear()}`;
    const seq = await FinanceSequenceModel.getNext(tenantId, "creditNoteNumber", year);
    return `${config.creditNoteNumberPrefix}-${year}-${String(seq).padStart(6, "0")}`;
  }

  static async _sumPriorIssuedCredits(tenantId, invoiceId, excludeCreditNoteId = null) {
    const filter = { tenantId, invoiceId, status: { $in: [...COUNTS_AGAINST_CAP_STATUSES] } };
    if (excludeCreditNoteId) filter._id = { $ne: excludeCreditNoteId };
    const notes = await CreditNoteModel.find(filter).select("grandTotal").lean();
    return roundCurrency(notes.reduce((sum, n) => sum + n.grandTotal, 0));
  }

  static async _generatePdf(creditNoteDoc) {
    const buffer = await CreditNotePdfService.generatePdfBuffer({
      creditNumber: creditNoteDoc.creditNumber, status: creditNoteDoc.status, issuedAt: creditNoteDoc.issuedAt,
      invoiceNumber: creditNoteDoc.invoiceNumber, customerName: creditNoteDoc.customerName, reason: creditNoteDoc.reason,
      currency: creditNoteDoc.currency, items: creditNoteDoc.items, creditAmount: creditNoteDoc.creditAmount,
      taxAdjustmentTotal: creditNoteDoc.taxAdjustmentTotal, grandTotal: creditNoteDoc.grandTotal, disposition: creditNoteDoc.disposition
    });
    const stored = await storeDocumentPdf({ tenantId: creditNoteDoc.tenantId, folder: "credit-notes", filename: `${creditNoteDoc.creditNumber}.pdf`, buffer });
    return { url: stored.url, storageKey: stored.storageKey, storageProvider: stored.storageProvider, generatedAt: new Date() };
  }

  /**
   * POST /api/v1/credit-notes
   * Validate Invoice -> Validate Remaining Credit -> Calculate Taxes ->
   * Generate Credit Number -> Generate PDF -> Timeline -> Audit -> Publish
   * CreditNoteCreated. Unlike Invoice's InvoiceCreated (deliberately deferred
   * to Issue because of AR's listener contract), CreditNoteCreated has no
   * such collision — nothing subscribes expecting it to mean "AR already
   * adjusted" (that's CreditNoteAllocated's job, via a direct service call
   * in `allocate` below) — so it fires here, at real creation, matching this
   * codebase's default convention for every other "XCreated" event.
   */
  static async createCreditNote(data, tenantId, userId) {
    const config = getFinanceConfig();
    const { invoiceId, reason, reasonDetail = null, items: rawItems, disposition = config.defaultCreditNoteDisposition } = data;

    if (!invoiceId || !reason || !Array.isArray(rawItems) || rawItems.length === 0) {
      throw new Error("invoiceId, reason, and at least one item are required.");
    }
    if (!config.creditNoteReasons.includes(reason)) throw new Error(`Invalid reason "${reason}".`);
    if (!["CustomerCredit", "Refund"].includes(disposition)) throw new Error(`Invalid disposition "${disposition}".`);

    const invoice = await InvoiceModel.findOne({ _id: invoiceId, tenantId }).lean();
    if (!invoice) throw new Error("Invoice not found.");
    if (["Cancelled", "Voided", "Draft"].includes(invoice.status)) {
      throw new Error(`Cannot credit an invoice in status "${invoice.status}". The invoice must have been issued.`);
    }

    await FinancialPeriodService.assertPeriodOpen(tenantId, new Date());

    // Resolves each original line's taxCode as of the INVOICE's own
    // issueDate (not "now") — Part 20's real, effective-dated
    // TaxRuleModel means a credit note reproduces the exact historical
    // rate the invoice was originally taxed at, even if that rate has
    // since changed, rather than (as before Part 20 existed) silently
    // re-pricing the credit at today's config.taxCodes rate.
    const invoiceCustomer = await CustomerModel.findOne({ _id: invoice.customerId, tenantId }).lean();
    const creditTaxCodes = await TaxService.resolveRatesForCodes(
      invoice.items.map((line) => line.taxCode).filter(Boolean),
      { country: invoiceCustomer?.address?.country || null, state: invoiceCustomer?.address?.state || null, asOfDate: invoice.issueDate },
      tenantId
    );

    const computedItems = rawItems.map((item) => {
      const invoiceLine = invoice.items.find((line) => line._id.toString() === item.invoiceLineId.toString());
      if (!invoiceLine) throw new Error(`Invoice line "${item.invoiceLineId}" not found on invoice ${invoice.invoiceNumber}.`);
      return computeCreditLineTotals(item, invoiceLine, creditTaxCodes);
    });
    const totals = computeCreditNoteTotals(computedItems);

    const priorIssuedTotal = await CreditNoteService._sumPriorIssuedCredits(tenantId, invoice._id);
    const remaining = computeRemainingCreditable(invoice.grandTotal, priorIssuedTotal);
    if (totals.grandTotal > remaining) {
      throw new Error(`Credit amount ${totals.grandTotal} exceeds the remaining creditable amount (${remaining}) for invoice ${invoice.invoiceNumber}.`);
    }

    const creditNumber = await CreditNoteService._generateCreditNumber(tenantId);

    const creditNote = new CreditNoteModel({
      tenantId,
      creditNumber,
      invoiceId: invoice._id,
      invoiceNumber: invoice.invoiceNumber,
      customerId: invoice.customerId,
      customerName: invoice.customerName,
      reason,
      reasonDetail,
      status: config.defaultCreditNoteStatus,
      currency: invoice.currency,
      items: computedItems,
      ...totals,
      disposition,
      timeline: [{ event: "CreditNoteDraftCreated", description: `Draft credit note ${creditNumber} created against invoice ${invoice.invoiceNumber}.`, performedBy: userId || null }],
      createdBy: userId || null,
      updatedBy: userId || null
    });

    creditNote.pdf = await CreditNoteService._generatePdf(creditNote);
    await creditNote.save();

    await AuditLogModel.create({ action: "finance.creditnote.create", module: "Finance", resource: "CreditNote", resourceId: creditNote._id.toString(), userId: userId || null, tenantId, details: { creditNumber, invoiceNumber: invoice.invoiceNumber, grandTotal: totals.grandTotal } });
    publishEvent("CreditNoteCreated", { tenantId, creditNoteId: creditNote._id.toString(), invoiceId: invoice._id.toString(), invoiceNumber: invoice.invoiceNumber, customerId: invoice.customerId.toString(), grandTotal: totals.grandTotal, performedBy: userId || null });

    return creditNote.toJSON();
  }

  static async listCreditNotes(query, tenantId) {
    const config = getFinanceConfig();
    const { invoiceId, invoiceNumber, customerId, status, currency } = query;
    const filter = { tenantId };
    if (invoiceId) filter.invoiceId = invoiceId;
    if (invoiceNumber) filter.invoiceNumber = invoiceNumber;
    if (customerId) filter.customerId = customerId;
    if (status) filter.status = status;
    if (currency) filter.currency = currency;

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
      CreditNoteModel.find(filter).sort(sortSpec).skip(skip).limit(pageSize).lean(),
      CreditNoteModel.countDocuments(filter)
    ]);

    return { items, pagination: { total, page, pageSize, totalPages: Math.ceil(total / pageSize) } };
  }

  static async getCreditNoteById(creditNoteId, tenantId) {
    const creditNote = await CreditNoteModel.findOne({ _id: creditNoteId, tenantId }).lean();
    if (!creditNote) throw new Error("Credit note not found.");

    const auditSummary = await AuditLogModel.find({ tenantId, resource: "CreditNote", resourceId: creditNote._id.toString() }).sort({ createdAt: -1 }).limit(20).lean();
    return { ...creditNote, auditSummary };
  }

  /**
   * POST /api/v1/credit-notes/{creditNoteId}/approve — gap-fill, same
   * single configurable approval gate as Journal/AP/Invoice.
   */
  static async approveCreditNote(creditNoteId, tenantId, userId) {
    const creditNote = await CreditNoteModel.findOne({ _id: creditNoteId, tenantId });
    if (!creditNote) throw new Error("Credit note not found.");
    if (!isCreditNoteApprovable(creditNote.status)) throw new Error(`Credit note cannot be approved from status "${creditNote.status}".`);

    creditNote.status = "Approved";
    creditNote.approvedBy = userId || null;
    creditNote.approvedAt = new Date();
    creditNote.updatedBy = userId || null;
    creditNote.timeline.push({ event: "CreditNoteApproved", description: "Credit note approved.", performedBy: userId || null });
    await creditNote.save();

    await AuditLogModel.create({ action: "finance.creditnote.approve", module: "Finance", resource: "CreditNote", resourceId: creditNote._id.toString(), userId: userId || null, tenantId, details: {} });
    publishEvent("CreditNoteApproved", { tenantId, creditNoteId: creditNote._id.toString(), invoiceNumber: creditNote.invoiceNumber, performedBy: userId || null });

    return creditNote.toJSON();
  }

  /**
   * POST /api/v1/credit-notes/{creditNoteId}/issue — gap-fill (Approved ->
   * Issued has no other trigger given, mirrors Invoice's own issue step).
   * Finalizes the document (PDF) but does NOT touch Accounts Receivable yet
   * — that's `allocate` below, a deliberately separate step so an issued
   * credit note can still be voided before its financial effect posts
   * (matches Invoice's "void only before payments/allocation" rule).
   */
  static async issueCreditNote(creditNoteId, tenantId, userId) {
    const config = getFinanceConfig();
    const creditNote = await CreditNoteModel.findOne({ _id: creditNoteId, tenantId });
    if (!creditNote) throw new Error("Credit note not found.");
    if (!isCreditNoteIssuable(creditNote.status, config.creditNoteApprovalRequired)) {
      throw new Error(`Credit note cannot be issued from status "${creditNote.status}".${config.creditNoteApprovalRequired ? " It must be Approved first." : ""}`);
    }

    // Re-validate the remaining creditable amount — another credit note
    // against the same invoice may have been issued since this one was
    // drafted (same re-check discipline as Journal/Invoice's period-open
    // checks).
    const invoice = await InvoiceModel.findOne({ _id: creditNote.invoiceId, tenantId }).lean();
    if (!invoice) throw new Error("Linked invoice no longer exists.");
    const priorIssuedTotal = await CreditNoteService._sumPriorIssuedCredits(tenantId, invoice._id, creditNote._id);
    const remaining = computeRemainingCreditable(invoice.grandTotal, priorIssuedTotal);
    if (creditNote.grandTotal > remaining) {
      throw new Error(`Credit amount ${creditNote.grandTotal} exceeds the remaining creditable amount (${remaining}) for invoice ${invoice.invoiceNumber}.`);
    }
    await FinancialPeriodService.assertPeriodOpen(tenantId, new Date());

    creditNote.status = "Issued";
    creditNote.issuedBy = userId || null;
    creditNote.issuedAt = new Date();
    creditNote.updatedBy = userId || null;
    creditNote.timeline.push({ event: "CreditNoteIssued", description: "Credit note issued.", performedBy: userId || null });
    creditNote.pdf = await CreditNoteService._generatePdf(creditNote);
    await creditNote.save();

    await AuditLogModel.create({ action: "finance.creditnote.issue", module: "Finance", resource: "CreditNote", resourceId: creditNote._id.toString(), userId: userId || null, tenantId, details: { grandTotal: creditNote.grandTotal } });
    publishEvent("CreditNoteIssued", { tenantId, creditNoteId: creditNote._id.toString(), invoiceNumber: creditNote.invoiceNumber, grandTotal: creditNote.grandTotal, performedBy: userId || null });

    return creditNote.toJSON();
  }

  /**
   * POST /api/v1/credit-notes/{creditNoteId}/allocate — gap-fill:
   * `CreditNoteAllocated` is a named domain event with no endpoint. "Update
   * Accounts Receivable -> Generate Journal -> Update Ledger" from the
   * spec's own Business Workflow happens here. Journal: Debit Revenue /
   * Credit AR control (the mirror-opposite of Invoice's own AR-creation
   * journal — crediting a customer literally reverses part of it).
   *
   * "Refund Eligibility... Approved Refund OR Customer Credit Wallet": the
   * excess of this credit beyond the receivable's outstanding balance
   * ALWAYS becomes real Customer Credit (via AccountsReceivableService.applyCreditNote,
   * which reuses the exact overpayment-split math from payment allocation)
   * — there is no mechanism anywhere in this codebase to execute a real
   * bank refund automatically from a credit note (no source Payment record
   * to refund from, unlike PaymentService.refund which refunds a specific
   * payment's unallocated portion). When `disposition === 'Refund'`, this
   * additionally fires `RefundRequested` as a genuine signal for
   * finance-ops or a future Refund Management module to actually move
   * money, rather than fabricating an automatic payout.
   */
  static async allocateCreditNote(creditNoteId, tenantId, userId) {
    const config = getFinanceConfig();
    const creditNote = await CreditNoteModel.findOne({ _id: creditNoteId, tenantId });
    if (!creditNote) throw new Error("Credit note not found.");
    if (!isCreditNoteAllocatable(creditNote.status)) throw new Error(`Credit note cannot be allocated from status "${creditNote.status}".`);

    const receivable = await AccountsReceivableModel.findOne({ tenantId, invoiceNumber: creditNote.invoiceNumber });
    if (!receivable) throw new Error(`No Accounts Receivable record exists for invoice ${creditNote.invoiceNumber} — it may not have been issued yet.`);

    let journalId = null;
    if (config.defaultRevenueAccountCode && config.arControlAccountCode) {
      const journal = await JournalService.createJournal({
        journalType: "Automatic",
        postingDate: new Date(),
        description: `Credit note ${creditNote.creditNumber} applied to invoice ${creditNote.invoiceNumber}`,
        referenceNumber: creditNote.creditNumber,
        currency: creditNote.currency,
        lines: [
          { accountCode: config.defaultRevenueAccountCode, debit: creditNote.grandTotal },
          { accountCode: config.arControlAccountCode, credit: creditNote.grandTotal }
        ]
      }, tenantId, userId || "system");
      await JournalService.approveJournal(journal._id, tenantId, userId || "system");
      const posted = await JournalService.postJournal(journal._id, tenantId, userId || "system");
      journalId = posted?._id || journal._id;
    }

    const { credit } = await AccountsReceivableService.applyCreditNote(receivable._id, { amount: creditNote.grandTotal, creditNoteId: creditNote._id, reason: `${creditNote.reason} (${creditNote.creditNumber})` }, tenantId, userId);

    creditNote.status = "Allocated";
    creditNote.arReceivableId = receivable._id;
    creditNote.journalId = journalId;
    creditNote.customerCreditId = credit ? credit._id : null;
    creditNote.updatedBy = userId || null;
    creditNote.timeline.push({ event: "CreditNoteAllocated", description: `Applied to receivable for invoice ${creditNote.invoiceNumber}.`, performedBy: userId || null });
    await creditNote.save();

    await AuditLogModel.create({ action: "finance.creditnote.allocate", module: "Finance", resource: "CreditNote", resourceId: creditNote._id.toString(), userId: userId || null, tenantId, details: { receivableId: receivable._id.toString(), journalId: journalId ? journalId.toString() : null, customerCreditId: credit ? credit._id : null } });
    publishEvent("CreditNoteAllocated", { tenantId, creditNoteId: creditNote._id.toString(), invoiceNumber: creditNote.invoiceNumber, receivableId: receivable._id.toString(), grandTotal: creditNote.grandTotal, performedBy: userId || null });

    if (creditNote.disposition === "Refund") {
      publishEvent("RefundRequested", { tenantId, creditNoteId: creditNote._id.toString(), customerId: creditNote.customerId.toString(), amount: creditNote.grandTotal, currency: creditNote.currency, reason: creditNote.reason, performedBy: userId || null });
    }

    return creditNote.toJSON();
  }

  /**
   * POST /api/v1/credit-notes/{creditNoteId}/cancel — gap-fill. Covers the
   * "this credit note doesn't proceed" outcome for every pre-issue state.
   * No separate reject() action was built: unlike Journal (whose spec names
   * `JournalRejected` as a real event), this spec's own Domain Events list
   * has no `CreditNoteRejected` — Cancel already covers it.
   */
  static async cancelCreditNote(creditNoteId, data, tenantId, userId) {
    const creditNote = await CreditNoteModel.findOne({ _id: creditNoteId, tenantId });
    if (!creditNote) throw new Error("Credit note not found.");
    if (!isCreditNoteCancellable(creditNote.status)) throw new Error(`Credit note cannot be cancelled from status "${creditNote.status}". Issued credit notes must be voided instead.`);

    creditNote.status = "Cancelled";
    creditNote.cancelledBy = userId || null;
    creditNote.cancelledAt = new Date();
    creditNote.cancellationReason = data?.reason || null;
    creditNote.updatedBy = userId || null;
    creditNote.timeline.push({ event: "CreditNoteCancelled", description: data?.reason || "Credit note cancelled.", performedBy: userId || null });
    await creditNote.save();

    await AuditLogModel.create({ action: "finance.creditnote.cancel", module: "Finance", resource: "CreditNote", resourceId: creditNote._id.toString(), userId: userId || null, tenantId, details: { reason: data?.reason || null } });
    publishEvent("CreditNoteCancelled", { tenantId, creditNoteId: creditNote._id.toString(), invoiceNumber: creditNote.invoiceNumber, performedBy: userId || null });

    return creditNote.toJSON();
  }

  /**
   * POST /api/v1/credit-notes/{creditNoteId}/void — gap-fill:
   * `CreditNoteVoided` is a named domain event with no endpoint. Only for an
   * Issued credit note that hasn't been allocated to AR yet — once it has
   * touched AR/the ledger, there is no reversal endpoint (same rule as
   * Invoice's own void — "once money moved, use the receivable's own
   * mechanisms instead").
   */
  static async voidCreditNote(creditNoteId, data, tenantId, userId) {
    const creditNote = await CreditNoteModel.findOne({ _id: creditNoteId, tenantId });
    if (!creditNote) throw new Error("Credit note not found.");
    if (!isCreditNoteVoidable(creditNote.status)) throw new Error(`Credit note cannot be voided from status "${creditNote.status}".`);

    creditNote.status = "Voided";
    creditNote.voidedBy = userId || null;
    creditNote.voidedAt = new Date();
    creditNote.updatedBy = userId || null;
    creditNote.timeline.push({ event: "CreditNoteVoided", description: data?.reason || "Credit note voided.", performedBy: userId || null });
    await creditNote.save();

    await AuditLogModel.create({ action: "finance.creditnote.void", module: "Finance", resource: "CreditNote", resourceId: creditNote._id.toString(), userId: userId || null, tenantId, details: { reason: data?.reason || null } });
    publishEvent("CreditNoteVoided", { tenantId, creditNoteId: creditNote._id.toString(), invoiceNumber: creditNote.invoiceNumber, performedBy: userId || null });

    return creditNote.toJSON();
  }

  static async closeCreditNote(creditNoteId, tenantId, userId) {
    const creditNote = await CreditNoteModel.findOne({ _id: creditNoteId, tenantId });
    if (!creditNote) throw new Error("Credit note not found.");
    if (!isCreditNoteCloseable(creditNote.status)) throw new Error(`Credit note cannot be closed from status "${creditNote.status}".`);

    creditNote.status = "Closed";
    creditNote.closedBy = userId || null;
    creditNote.closedAt = new Date();
    creditNote.updatedBy = userId || null;
    creditNote.timeline.push({ event: "CreditNoteClosed", description: "Credit note closed.", performedBy: userId || null });
    await creditNote.save();

    await AuditLogModel.create({ action: "finance.creditnote.close", module: "Finance", resource: "CreditNote", resourceId: creditNote._id.toString(), userId: userId || null, tenantId, details: {} });
    publishEvent("CreditNoteClosed", { tenantId, creditNoteId: creditNote._id.toString(), invoiceNumber: creditNote.invoiceNumber, performedBy: userId || null });

    return creditNote.toJSON();
  }
}

export default CreditNoteService;
