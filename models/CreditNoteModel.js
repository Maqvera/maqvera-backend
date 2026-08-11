import mongoose from "mongoose";

// Enterprise Credit Notes — Finance Module Part 10. "Invoice Created ->
// Customer Returns Item -> Credit Note Issued -> Accounts Receivable
// Adjusted -> Customer Credit Wallet Updated OR Refund Issued." Tenant-scoped
// only — no branchId (see docs/06-external-integrations/03-final-architecture-no-branches-rbac.md).
//
// Reuses two placeholders built specifically for this module: InvoiceModel's
// and AccountsReceivableModel's `creditNoteIds[]` (Parts 9 and 5), and
// AccountsReceivableModel's `adjustments[].type` already documenting
// "CreditNoteApplied" as a valid value (Part 5).
const CreditNoteLineItemSchema = new mongoose.Schema({
  // The original invoice line this credit note item is crediting against —
  // validated to exist on the invoice at creation time, not enforced to
  // stay within the original line's remaining quantity (see
  // CreditNoteService.js doc comment on why "Validate Remaining Credit" is
  // implemented at the invoice-total level, not per-line).
  invoiceLineId: { type: mongoose.Schema.Types.ObjectId, required: true },
  description: { type: String, required: true },
  quantity: { type: Number, required: true, min: 0.01 },
  // The credit amount for this line, BEFORE tax — caller-supplied directly
  // (not recomputed from the original unit price), matching the spec's own
  // request example. Tax is then recalculated for real against the
  // ORIGINAL invoice line's taxCode/rate, not guessed.
  amount: { type: Number, required: true, min: 0 },
  taxCode: { type: String, default: null },
  taxAdjustment: { type: Number, required: true, default: 0 },
  lineTotal: { type: Number, required: true }
}, { _id: true });

const CreditNoteSchema = new mongoose.Schema({
  tenantId: {
    type: String,
    required: true,
    index: true
  },
  creditNumber: {
    type: String,
    required: true,
    immutable: true
  },
  invoiceId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "invoice",
    required: true,
    index: true
  },
  invoiceNumber: {
    type: String,
    required: true,
    index: true
  },
  customerId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "customer",
    required: true,
    index: true
  },
  customerName: {
    type: String,
    required: true
  },
  // Config-driven (creditNoteReasons) — Product Return, Service
  // Cancellation, Pricing Correction, Tax Correction, Billing Error,
  // Customer Goodwill, Other.
  reason: {
    type: String,
    required: true
  },
  reasonDetail: { type: String, default: null },
  // Config-driven (creditNoteStatuses) — Draft, Pending Approval, Approved,
  // Issued, Allocated, Closed, Cancelled, Voided. Issued and Allocated are
  // deliberately separate actions/states (unlike AP's Approved->Open
  // collapse) — Issued finalizes the document with no AR effect yet;
  // Allocated is the step that actually posts to Accounts Receivable/the
  // Ledger, so an Issued-but-not-yet-Allocated credit note can still be
  // voided cleanly. See CreditNoteService.js issueCreditNote/allocateCreditNote.
  status: {
    type: String,
    required: true,
    index: true
  },
  currency: {
    type: String,
    required: true
  },
  items: {
    type: [CreditNoteLineItemSchema],
    validate: {
      validator: (items) => Array.isArray(items) && items.length >= 1,
      message: "A credit note requires at least one line item."
    }
  },
  creditAmount: { type: Number, required: true },
  taxAdjustmentTotal: { type: Number, required: true },
  grandTotal: { type: Number, required: true },
  // "Refund Eligibility... Approved Refund OR Customer Credit Wallet" — see
  // utils/financeConfig.js defaultCreditNoteDisposition doc comment.
  disposition: {
    type: String,
    enum: ["CustomerCredit", "Refund"],
    required: true
  },
  // Resolved at issue-time by joining the receivable created for this
  // invoice (same "cache of a live join, not the authority" discipline as
  // InvoiceModel.arReceivableId).
  arReceivableId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "accounts_receivable",
    default: null
  },
  // Set only when disposition resolves into a real CustomerCredit record
  // (the excess-beyond-outstanding-balance portion, or the whole amount if
  // the receivable was already fully paid).
  customerCreditId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "customer_credit",
    default: null
  },
  journalId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "journal",
    default: null
  },
  pdf: {
    url: { type: String, default: null },
    storageKey: { type: String, default: null },
    storageProvider: { type: String, default: null },
    generatedAt: { type: Date, default: null }
  },
  approvedBy: { type: String, default: null },
  approvedAt: { type: Date, default: null },
  issuedBy: { type: String, default: null },
  issuedAt: { type: Date, default: null },
  cancelledBy: { type: String, default: null },
  cancelledAt: { type: Date, default: null },
  cancellationReason: { type: String, default: null },
  voidedBy: { type: String, default: null },
  voidedAt: { type: Date, default: null },
  closedBy: { type: String, default: null },
  closedAt: { type: Date, default: null },
  timeline: [{
    event: { type: String, required: true },
    description: { type: String, default: null },
    performedBy: { type: String, default: null },
    performedAt: { type: Date, default: Date.now }
  }],
  createdBy: { type: String, default: null },
  updatedBy: { type: String, default: null }
}, { timestamps: true });

CreditNoteSchema.index({ tenantId: 1, creditNumber: 1 }, { unique: true });
CreditNoteSchema.index({ tenantId: 1, invoiceId: 1 });
CreditNoteSchema.index({ tenantId: 1, customerId: 1, status: 1 });

CreditNoteSchema.set("toJSON", {
  transform: (_, ret) => {
    delete ret.__v;
    return ret;
  }
});

const CreditNoteModel = mongoose.model("credit_note", CreditNoteSchema);

export default CreditNoteModel;
