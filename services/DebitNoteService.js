import DebitNoteModel from "../models/DebitNoteModel.js";
import InvoiceModel from "../models/InvoiceModel.js";
import AccountsPayableModel from "../models/AccountsPayableModel.js";
import AccountsReceivableModel from "../models/AccountsReceivableModel.js";
import AccountsReceivableService from "./AccountsReceivableService.js";
import AccountsPayableService from "./AccountsPayableService.js";
import CustomerModel from "../models/CustomerModel.js";
import VendorModel from "../models/VendorModel.js";
import JournalService from "./JournalService.js";
import FinancialPeriodService from "./FinancialPeriodService.js";
import FinanceSequenceModel from "../models/FinanceSequenceModel.js";
import AuditLogModel from "../models/AuditLogmodel.js";
import DebitNotePdfService from "./DebitNotePdfService.js";
import TaxService from "./TaxService.js";
import { storeDocumentPdf } from "../utils/documentPdfStorage.js";
import { publishEvent } from "../utils/eventBus.js";
import { getFinanceConfig } from "../utils/financeConfig.js";
import { resolveTaxRate } from "./InvoiceService.js";
import { resolveTenantBranding } from "../utils/tenantBranding.js";

const roundCurrency = (value) => Math.round((Number(value) || 0) * 100) / 100;

// ---------------------------------------------------------------------------
// Pure helpers — no DB access, unit-testable directly (see
// tests/debitNoteService.test.js).
// ---------------------------------------------------------------------------

/**
 * Unlike Credit Note's computeCreditLineTotals, there is no original
 * invoice line to recalculate tax from — the spec's own request example
 * ({description, amount}, e.g. "Urgent Processing": 150) shows debit note
 * items are new charges with no line to reference back to. Tax is instead
 * computed from an optional caller-supplied `taxCode`, validated against
 * config.taxCodes (resolveTaxRate already throws on an unknown code).
 */
export const computeDebitLineTotals = (item, taxCodes) => {
  if (!item.description) throw new Error("Each debit note line item requires a description.");
  const amount = roundCurrency(Number(item.amount));
  if (!(amount > 0)) throw new Error(`Debit line "${item.description}": amount must be greater than zero.`);

  const taxCode = item.taxCode || null;
  const rate = resolveTaxRate(taxCode, taxCodes);
  const taxAdjustment = roundCurrency(amount * rate);
  const lineTotal = roundCurrency(amount + taxAdjustment);

  return { description: item.description, amount, taxCode, taxAdjustment, lineTotal };
};

/** Sums computed debit line items into debit-note-level totals. */
export const computeDebitNoteTotals = (computedItems) => {
  const debitAmount = roundCurrency(computedItems.reduce((sum, i) => sum + i.amount, 0));
  const taxAdjustmentTotal = roundCurrency(computedItems.reduce((sum, i) => sum + i.taxAdjustment, 0));
  const grandTotal = roundCurrency(computedItems.reduce((sum, i) => sum + i.lineTotal, 0));
  return { debitAmount, taxAdjustmentTotal, grandTotal };
};

const APPROVABLE_STATUSES = new Set(["Draft", "Pending Approval"]);
const CANCELLABLE_STATUSES = new Set(["Draft", "Pending Approval", "Approved"]);
const VOIDABLE_STATUSES = new Set(["Issued"]);
const CLOSEABLE_STATUSES = new Set(["Allocated"]);

export const isDebitNoteApprovable = (status) => APPROVABLE_STATUSES.has(status);
export const isDebitNoteIssuable = (status, approvalRequired) => (approvalRequired ? status === "Approved" : status === "Draft" || status === "Approved");
export const isDebitNoteAllocatable = (status) => status === "Issued";
export const isDebitNoteCancellable = (status) => CANCELLABLE_STATUSES.has(status);
export const isDebitNoteVoidable = (status) => VOIDABLE_STATUSES.has(status);
export const isDebitNoteCloseable = (status) => CLOSEABLE_STATUSES.has(status);

// Invoice/Payable statuses a debit note cannot be raised against — an
// obligation that never became real (Draft) or is a genuine dead end
// (Cancelled/Voided/Written Off) can't be charged more.
const INVOICE_BLOCKED_STATUSES = new Set(["Draft", "Cancelled", "Voided"]);
const PAYABLE_BLOCKED_STATUSES = new Set(["Draft", "Cancelled", "Written Off"]);

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

class DebitNoteService {
  static async _generateDebitNumber(tenantId) {
    const config = getFinanceConfig();
    const year = `${new Date().getUTCFullYear()}`;
    const seq = await FinanceSequenceModel.getNext(tenantId, "debitNoteNumber", year);
    return `${config.debitNoteNumberPrefix}-${year}-${String(seq).padStart(6, "0")}`;
  }

  static async _generatePdf(debitNoteDoc) {
    const company = await resolveTenantBranding(debitNoteDoc.tenantId);
    const buffer = await DebitNotePdfService.generatePdfBuffer({
      debitNumber: debitNoteDoc.debitNumber, status: debitNoteDoc.status, issuedAt: debitNoteDoc.issuedAt,
      partyType: debitNoteDoc.partyType, invoiceNumber: debitNoteDoc.invoiceNumber,
      customerName: debitNoteDoc.customerName, vendorName: debitNoteDoc.vendorName, reason: debitNoteDoc.reason,
      currency: debitNoteDoc.currency, items: debitNoteDoc.items, debitAmount: debitNoteDoc.debitAmount,
      taxAdjustmentTotal: debitNoteDoc.taxAdjustmentTotal, grandTotal: debitNoteDoc.grandTotal,
      company
    });
    const stored = await storeDocumentPdf({ tenantId: debitNoteDoc.tenantId, folder: "debit-notes", filename: `${debitNoteDoc.debitNumber}.pdf`, buffer });
    return { url: stored.url, storageKey: stored.storageKey, storageProvider: stored.storageProvider, generatedAt: new Date() };
  }

  /**
   * POST /api/v1/debit-notes
   * Validate Invoice/Payable -> Validate Adjustment Rules -> Calculate
   * Taxes -> Generate Debit Number -> Generate PDF -> Timeline -> Audit ->
   * Publish DebitNoteCreated. Party-aware (see DebitNoteModel.js doc
   * comment): `partyType: "Customer"` requires `invoiceId` (a real Invoice
   * record); `partyType: "Vendor"` requires `payableId` (AccountsPayable
   * directly — no VendorInvoice model exists in this codebase).
   */
  static async createDebitNote(data, tenantId, userId) {
    const config = getFinanceConfig();
    const { partyType, invoiceId = null, payableId = null, reason, reasonDetail = null, items: rawItems, glAccountCode = null } = data;

    if (!["Customer", "Vendor"].includes(partyType)) throw new Error("partyType must be either \"Customer\" or \"Vendor\".");
    if (!reason || !Array.isArray(rawItems) || rawItems.length === 0) {
      throw new Error("reason and at least one item are required.");
    }
    if (!config.debitNoteReasons.includes(reason)) throw new Error(`Invalid reason "${reason}".`);

    let partyFields;
    if (partyType === "Customer") {
      if (!invoiceId) throw new Error("invoiceId is required for a Customer debit note.");
      const invoice = await InvoiceModel.findOne({ _id: invoiceId, tenantId }).lean();
      if (!invoice) throw new Error("Invoice not found.");
      if (INVOICE_BLOCKED_STATUSES.has(invoice.status)) {
        throw new Error(`Cannot raise a debit note against an invoice in status "${invoice.status}". The invoice must have been issued.`);
      }
      partyFields = {
        customerId: invoice.customerId, customerName: invoice.customerName,
        invoiceId: invoice._id, invoiceNumber: invoice.invoiceNumber, currency: invoice.currency
      };
    } else {
      if (!payableId) throw new Error("payableId is required for a Vendor debit note.");
      const payable = await AccountsPayableModel.findOne({ _id: payableId, tenantId }).lean();
      if (!payable) throw new Error("Payable not found.");
      if (PAYABLE_BLOCKED_STATUSES.has(payable.status)) {
        throw new Error(`Cannot raise a debit note against a payable in status "${payable.status}". The payable must have been approved.`);
      }
      partyFields = {
        vendorId: payable.vendorId, vendorName: payable.vendorName,
        payableId: payable._id, invoiceNumber: payable.invoiceNumber, currency: payable.currency
      };
    }

    await FinancialPeriodService.assertPeriodOpen(tenantId, new Date());

    // Real jurisdiction resolution (Part 20) — Customer debit notes use
    // the customer's own address country/state; Vendor debit notes use
    // the vendor's own (required) country field. Falls through to
    // TaxService's own static config.taxCodes fallback when neither
    // resolves a country, same backward-compatible behavior as before
    // this Part existed.
    let jurisdiction = { country: null, state: null };
    if (partyType === "Customer") {
      const customer = await CustomerModel.findOne({ _id: partyFields.customerId, tenantId }).lean();
      jurisdiction = { country: customer?.address?.country || null, state: customer?.address?.state || null };
    } else {
      const vendor = await VendorModel.findOne({ _id: partyFields.vendorId, tenantId }).lean();
      jurisdiction = { country: vendor?.country || null, state: null };
    }
    const debitTaxCodes = await TaxService.resolveRatesForCodes(rawItems.map((item) => item.taxCode).filter(Boolean), jurisdiction, tenantId);

    const computedItems = rawItems.map((item) => computeDebitLineTotals(item, debitTaxCodes));
    const totals = computeDebitNoteTotals(computedItems);

    const debitNumber = await DebitNoteService._generateDebitNumber(tenantId);

    const debitNote = new DebitNoteModel({
      tenantId,
      debitNumber,
      partyType,
      ...partyFields,
      reason,
      reasonDetail,
      status: config.defaultDebitNoteStatus,
      items: computedItems,
      ...totals,
      glAccountCode,
      timeline: [{ event: "DebitNoteDraftCreated", description: `Draft debit note ${debitNumber} created against ${partyFields.invoiceNumber}.`, performedBy: userId || null }],
      createdBy: userId || null,
      updatedBy: userId || null
    });

    debitNote.pdf = await DebitNoteService._generatePdf(debitNote);
    await debitNote.save();

    await AuditLogModel.create({ action: "finance.debitnote.create", module: "Finance", resource: "DebitNote", resourceId: debitNote._id.toString(), userId: userId || null, tenantId, details: { debitNumber, partyType, invoiceNumber: partyFields.invoiceNumber, grandTotal: totals.grandTotal } });
    publishEvent("DebitNoteCreated", { tenantId, debitNoteId: debitNote._id.toString(), partyType, invoiceId: invoiceId ? invoiceId.toString() : null, payableId: payableId ? payableId.toString() : null, customerId: partyFields.customerId ? partyFields.customerId.toString() : null, vendorId: partyFields.vendorId ? partyFields.vendorId.toString() : null, grandTotal: totals.grandTotal, performedBy: userId || null });

    return debitNote.toJSON();
  }

  /**
   * GET /api/v1/debit-notes
   */
  static async listDebitNotes(query, tenantId) {
    const config = getFinanceConfig();
    const { partyType, customerId, vendorId, invoiceId, payableId, status, reason, currency } = query;
    const filter = { tenantId };
    if (partyType) filter.partyType = partyType;
    if (customerId) filter.customerId = customerId;
    if (vendorId) filter.vendorId = vendorId;
    if (invoiceId) filter.invoiceId = invoiceId;
    if (payableId) filter.payableId = payableId;
    if (status) filter.status = status;
    if (reason) filter.reason = reason;
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
      DebitNoteModel.find(filter).sort(sortSpec).skip(skip).limit(pageSize).lean(),
      DebitNoteModel.countDocuments(filter)
    ]);

    return { items, pagination: { total, page, pageSize, totalPages: Math.ceil(total / pageSize) } };
  }

  /**
   * GET /api/v1/debit-notes/{debitNoteId}
   */
  static async getDebitNoteById(debitNoteId, tenantId) {
    const debitNote = await DebitNoteModel.findOne({ _id: debitNoteId, tenantId }).lean();
    if (!debitNote) throw new Error("Debit note not found.");

    const auditSummary = await AuditLogModel.find({ tenantId, resource: "DebitNote", resourceId: debitNote._id.toString() }).sort({ createdAt: -1 }).limit(20).lean();
    return { ...debitNote, auditSummary };
  }

  /**
   * POST /api/v1/debit-notes/{debitNoteId}/approve — gap-fill, same single
   * configurable approval gate as Credit Note/Journal/AP/Invoice.
   */
  static async approveDebitNote(debitNoteId, tenantId, userId) {
    const debitNote = await DebitNoteModel.findOne({ _id: debitNoteId, tenantId });
    if (!debitNote) throw new Error("Debit note not found.");
    if (!isDebitNoteApprovable(debitNote.status)) throw new Error(`Debit note cannot be approved from status "${debitNote.status}".`);

    debitNote.status = "Approved";
    debitNote.approvedBy = userId || null;
    debitNote.approvedAt = new Date();
    debitNote.updatedBy = userId || null;
    debitNote.timeline.push({ event: "DebitNoteApproved", description: "Debit note approved.", performedBy: userId || null });
    await debitNote.save();

    await AuditLogModel.create({ action: "finance.debitnote.approve", module: "Finance", resource: "DebitNote", resourceId: debitNote._id.toString(), userId: userId || null, tenantId, details: {} });
    publishEvent("DebitNoteApproved", { tenantId, debitNoteId: debitNote._id.toString(), invoiceNumber: debitNote.invoiceNumber, performedBy: userId || null });

    return debitNote.toJSON();
  }

  /**
   * POST /api/v1/debit-notes/{debitNoteId}/issue — gap-fill (Approved ->
   * Issued has no other trigger given, mirrors Credit Note's own issue
   * step). Finalizes the document (PDF) but does NOT touch AR/AP yet —
   * that's `allocate` below, kept as a deliberately separate step so an
   * issued debit note can still be voided before its financial effect
   * posts.
   */
  static async issueDebitNote(debitNoteId, tenantId, userId) {
    const config = getFinanceConfig();
    const debitNote = await DebitNoteModel.findOne({ _id: debitNoteId, tenantId });
    if (!debitNote) throw new Error("Debit note not found.");
    if (!isDebitNoteIssuable(debitNote.status, config.debitNoteApprovalRequired)) {
      throw new Error(`Debit note cannot be issued from status "${debitNote.status}".${config.debitNoteApprovalRequired ? " It must be Approved first." : ""}`);
    }

    await FinancialPeriodService.assertPeriodOpen(tenantId, new Date());

    debitNote.status = "Issued";
    debitNote.issuedBy = userId || null;
    debitNote.issuedAt = new Date();
    debitNote.updatedBy = userId || null;
    debitNote.timeline.push({ event: "DebitNoteIssued", description: "Debit note issued.", performedBy: userId || null });
    debitNote.pdf = await DebitNoteService._generatePdf(debitNote);
    await debitNote.save();

    await AuditLogModel.create({ action: "finance.debitnote.issue", module: "Finance", resource: "DebitNote", resourceId: debitNote._id.toString(), userId: userId || null, tenantId, details: { grandTotal: debitNote.grandTotal } });
    publishEvent("DebitNoteIssued", { tenantId, debitNoteId: debitNote._id.toString(), invoiceNumber: debitNote.invoiceNumber, grandTotal: debitNote.grandTotal, performedBy: userId || null });

    return debitNote.toJSON();
  }

  /**
   * POST /api/v1/debit-notes/{debitNoteId}/allocate — gap-fill:
   * `DebitNoteAllocated` is a named domain event with no endpoint. "Update
   * AR/AP -> Generate Journal -> Update Ledger" from the spec's own
   * Business Workflow happens here, dispatched to AR or AP's applyDebitNote
   * depending on partyType. Journal: for a Customer debit note, Debit AR
   * control / Credit Revenue (the mirror-opposite of Credit Note's own
   * reversal, and the same direction as an original invoice's creation
   * journal — increasing what's owed is, ledger-wise, another sale); for a
   * Vendor debit note, Debit Expense / Credit AP control (increasing a
   * liability). Both `OutstandingBalanceIncreased` (fired by AR/AP's own
   * applyDebitNote) and `AdditionalChargeApplied` fire together here — the
   * spec names both events with no distinguishing trigger between them, so
   * neither is invented.
   */
  static async allocateDebitNote(debitNoteId, tenantId, userId) {
    const config = getFinanceConfig();
    const debitNote = await DebitNoteModel.findOne({ _id: debitNoteId, tenantId });
    if (!debitNote) throw new Error("Debit note not found.");
    if (!isDebitNoteAllocatable(debitNote.status)) throw new Error(`Debit note cannot be allocated from status "${debitNote.status}".`);

    let journalId = null;
    let targetId = null;

    if (debitNote.partyType === "Customer") {
      const receivable = await AccountsReceivableModel.findOne({ tenantId, invoiceNumber: debitNote.invoiceNumber });
      if (!receivable) throw new Error(`No Accounts Receivable record exists for invoice ${debitNote.invoiceNumber}.`);

      if (config.arControlAccountCode && debitNote.glAccountCode) {
        const journal = await JournalService.createJournal({
          journalType: "Automatic",
          postingDate: new Date(),
          description: `Debit note ${debitNote.debitNumber} applied to invoice ${debitNote.invoiceNumber}`,
          referenceNumber: debitNote.debitNumber,
          currency: debitNote.currency,
          lines: [
            { accountCode: config.arControlAccountCode, debit: debitNote.grandTotal },
            { accountCode: debitNote.glAccountCode, credit: debitNote.grandTotal }
          ]
        }, tenantId, userId || "system");
        await JournalService.approveJournal(journal._id, tenantId, userId || "system");
        const posted = await JournalService.postJournal(journal._id, tenantId, userId || "system");
        journalId = posted?._id || journal._id;
      }

      await AccountsReceivableService.applyDebitNote(receivable._id, { amount: debitNote.grandTotal, debitNoteId: debitNote._id, reason: `${debitNote.reason} (${debitNote.debitNumber})` }, tenantId, userId);
      debitNote.arReceivableId = receivable._id;
      targetId = receivable._id;
    } else {
      const payable = await AccountsPayableModel.findOne({ tenantId, invoiceNumber: debitNote.invoiceNumber, vendorId: debitNote.vendorId });
      if (!payable) throw new Error(`No Accounts Payable record exists for ${debitNote.invoiceNumber}.`);

      if (config.apControlAccountCode && debitNote.glAccountCode) {
        const journal = await JournalService.createJournal({
          journalType: "Automatic",
          postingDate: new Date(),
          description: `Debit note ${debitNote.debitNumber} applied to payable ${debitNote.invoiceNumber}`,
          referenceNumber: debitNote.debitNumber,
          currency: debitNote.currency,
          lines: [
            { accountCode: debitNote.glAccountCode, debit: debitNote.grandTotal },
            { accountCode: config.apControlAccountCode, credit: debitNote.grandTotal }
          ]
        }, tenantId, userId || "system");
        await JournalService.approveJournal(journal._id, tenantId, userId || "system");
        const posted = await JournalService.postJournal(journal._id, tenantId, userId || "system");
        journalId = posted?._id || journal._id;
      }

      await AccountsPayableService.applyDebitNote(payable._id, { amount: debitNote.grandTotal, debitNoteId: debitNote._id, reason: `${debitNote.reason} (${debitNote.debitNumber})` }, tenantId, userId);
      debitNote.apPayableId = payable._id;
      targetId = payable._id;
    }

    debitNote.status = "Allocated";
    debitNote.allocatedBy = userId || null;
    debitNote.allocatedAt = new Date();
    debitNote.journalId = journalId;
    debitNote.updatedBy = userId || null;
    debitNote.timeline.push({ event: "DebitNoteAllocated", description: `Applied to ${debitNote.partyType === "Vendor" ? "payable" : "receivable"} for ${debitNote.invoiceNumber}.`, performedBy: userId || null });
    await debitNote.save();

    await AuditLogModel.create({ action: "finance.debitnote.allocate", module: "Finance", resource: "DebitNote", resourceId: debitNote._id.toString(), userId: userId || null, tenantId, details: { targetId: targetId.toString(), journalId: journalId ? journalId.toString() : null } });
    publishEvent("DebitNoteAllocated", { tenantId, debitNoteId: debitNote._id.toString(), partyType: debitNote.partyType, invoiceNumber: debitNote.invoiceNumber, grandTotal: debitNote.grandTotal, performedBy: userId || null });
    publishEvent("AdditionalChargeApplied", { tenantId, debitNoteId: debitNote._id.toString(), partyType: debitNote.partyType, invoiceNumber: debitNote.invoiceNumber, reason: debitNote.reason, grandTotal: debitNote.grandTotal, performedBy: userId || null });

    return debitNote.toJSON();
  }

  /**
   * POST /api/v1/debit-notes/{debitNoteId}/cancel — gap-fill. Covers the
   * "this debit note doesn't proceed" outcome for every pre-issue state.
   * No separate reject() action was built: even though the Debit Note
   * Lifecycle diagram names "Rejected" as an alternative-flow outcome, the
   * Domain Events list has no `DebitNoteRejected` — Cancel already covers
   * it (same call as Credit Note's own).
   */
  static async cancelDebitNote(debitNoteId, data, tenantId, userId) {
    const debitNote = await DebitNoteModel.findOne({ _id: debitNoteId, tenantId });
    if (!debitNote) throw new Error("Debit note not found.");
    if (!isDebitNoteCancellable(debitNote.status)) throw new Error(`Debit note cannot be cancelled from status "${debitNote.status}". Issued debit notes must be voided instead.`);

    debitNote.status = "Cancelled";
    debitNote.cancelledBy = userId || null;
    debitNote.cancelledAt = new Date();
    debitNote.cancellationReason = data?.reason || null;
    debitNote.updatedBy = userId || null;
    debitNote.timeline.push({ event: "DebitNoteCancelled", description: data?.reason || "Debit note cancelled.", performedBy: userId || null });
    await debitNote.save();

    await AuditLogModel.create({ action: "finance.debitnote.cancel", module: "Finance", resource: "DebitNote", resourceId: debitNote._id.toString(), userId: userId || null, tenantId, details: { reason: data?.reason || null } });
    publishEvent("DebitNoteCancelled", { tenantId, debitNoteId: debitNote._id.toString(), invoiceNumber: debitNote.invoiceNumber, performedBy: userId || null });

    return debitNote.toJSON();
  }

  /**
   * POST /api/v1/debit-notes/{debitNoteId}/void — gap-fill:
   * `DebitNoteVoided` is a named domain event with no endpoint. Only for an
   * Issued debit note that hasn't been allocated to AR/AP yet — once it has
   * touched AR/AP/the ledger, there is no reversal endpoint (same rule as
   * Credit Note's own void).
   */
  static async voidDebitNote(debitNoteId, data, tenantId, userId) {
    const debitNote = await DebitNoteModel.findOne({ _id: debitNoteId, tenantId });
    if (!debitNote) throw new Error("Debit note not found.");
    if (!isDebitNoteVoidable(debitNote.status)) throw new Error(`Debit note cannot be voided from status "${debitNote.status}".`);

    debitNote.status = "Voided";
    debitNote.voidedBy = userId || null;
    debitNote.voidedAt = new Date();
    debitNote.updatedBy = userId || null;
    debitNote.timeline.push({ event: "DebitNoteVoided", description: data?.reason || "Debit note voided.", performedBy: userId || null });
    await debitNote.save();

    await AuditLogModel.create({ action: "finance.debitnote.void", module: "Finance", resource: "DebitNote", resourceId: debitNote._id.toString(), userId: userId || null, tenantId, details: { reason: data?.reason || null } });
    publishEvent("DebitNoteVoided", { tenantId, debitNoteId: debitNote._id.toString(), invoiceNumber: debitNote.invoiceNumber, performedBy: userId || null });

    return debitNote.toJSON();
  }

  static async closeDebitNote(debitNoteId, tenantId, userId) {
    const debitNote = await DebitNoteModel.findOne({ _id: debitNoteId, tenantId });
    if (!debitNote) throw new Error("Debit note not found.");
    if (!isDebitNoteCloseable(debitNote.status)) throw new Error(`Debit note cannot be closed from status "${debitNote.status}".`);

    debitNote.status = "Closed";
    debitNote.closedBy = userId || null;
    debitNote.closedAt = new Date();
    debitNote.updatedBy = userId || null;
    debitNote.timeline.push({ event: "DebitNoteClosed", description: "Debit note closed.", performedBy: userId || null });
    await debitNote.save();

    await AuditLogModel.create({ action: "finance.debitnote.close", module: "Finance", resource: "DebitNote", resourceId: debitNote._id.toString(), userId: userId || null, tenantId, details: {} });
    publishEvent("DebitNoteClosed", { tenantId, debitNoteId: debitNote._id.toString(), invoiceNumber: debitNote.invoiceNumber, performedBy: userId || null });

    return debitNote.toJSON();
  }
}

export default DebitNoteService;
