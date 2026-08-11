import mongoose from "mongoose";

// Enterprise Debit Notes — Finance Module Part 11. Mirror-opposite of Credit
// Notes: increases (rather than decreases) an existing obligation. Unlike
// Credit Note (customer/AR-only), a Debit Note is party-aware — it can
// target either a customer's Accounts Receivable OR a vendor's Accounts
// Payable, because this codebase's own reality diverges from the spec here:
// no VendorInvoice model exists (AccountsPayableModel only carries a plain
// `invoiceNumber` string, not a ref), so the spec's single generic
// `invoiceId` request field cannot work uniformly for both parties. Instead:
// `partyType` selects which of `invoiceId` (ref invoice, Customer) or
// `payableId` (ref accounts_payable, Vendor) is required — see
// DebitNoteService.js and middleware/validateRequest.js debitNoteSchemas.
//
// Line items have NO `invoiceLineId` (unlike Credit Note) — the spec's own
// request example ({description, amount}, e.g. "Urgent Processing": 150)
// shows debit note items are new charges with no original line to
// reference back to; tax is computed from an optional caller-supplied
// `taxCode` validated against config.taxCodes instead.
const DebitNoteLineItemSchema = new mongoose.Schema({
  description: { type: String, required: true },
  amount: { type: Number, required: true, min: 0.01 },
  taxCode: { type: String, default: null },
  taxAdjustment: { type: Number, required: true, default: 0 },
  lineTotal: { type: Number, required: true }
}, { _id: true });

const DebitNoteSchema = new mongoose.Schema({
  tenantId: {
    type: String,
    required: true,
    index: true
  },
  debitNumber: {
    type: String,
    required: true,
    immutable: true
  },
  // Customer -> increases Accounts Receivable; Vendor -> increases Accounts
  // Payable. Drives which of invoiceId/payableId below is populated.
  partyType: {
    type: String,
    enum: ["Customer", "Vendor"],
    required: true,
    index: true
  },
  customerId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "customer",
    default: null,
    index: true
  },
  customerName: { type: String, default: null },
  vendorId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "vendor",
    default: null,
    index: true
  },
  vendorName: { type: String, default: null },
  // Customer debit notes reference a real Invoice. Vendor debit notes
  // reference the AP payable directly (no VendorInvoice model exists).
  invoiceId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "invoice",
    default: null,
    index: true
  },
  payableId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "accounts_payable",
    default: null,
    index: true
  },
  invoiceNumber: {
    type: String,
    required: true,
    index: true
  },
  // Config-driven (debitNoteReasons) — Additional Charges, Price Correction,
  // Underbilling Adjustment, Late Fee, Returned Cheque Charge, Tax
  // Adjustment, Shipping Correction, Contractual Penalty, Other.
  reason: {
    type: String,
    required: true
  },
  reasonDetail: { type: String, default: null },
  // Config-driven (debitNoteStatuses) — Draft, Pending Approval, Approved,
  // Issued, Allocated, Closed, Cancelled, Voided. Same Issued/Allocated
  // separation as Credit Note — Issued finalizes the document with no
  // AR/AP effect yet; Allocated is what actually increases the outstanding
  // balance and posts to the Ledger, keeping a void-before-consequence
  // window. See DebitNoteService.js issueDebitNote/allocateDebitNote.
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
    type: [DebitNoteLineItemSchema],
    validate: {
      validator: (items) => Array.isArray(items) && items.length >= 1,
      message: "A debit note requires at least one line item."
    }
  },
  debitAmount: { type: Number, required: true },
  taxAdjustmentTotal: { type: Number, required: true },
  grandTotal: { type: Number, required: true },
  // Optional caller-supplied GL account for the automatic allocation
  // journal's non-control-account line — a Revenue account for a Customer
  // debit note, an Expense account for a Vendor one (same "skip ledger
  // posting until configured" gap-fill precedent as
  // AccountsReceivableService.createReceivable's revenueAccountCode /
  // AccountsPayableService.createPayable's expenseAccountCode — no fixed
  // config-wide account code exists for either side of a debit note).
  glAccountCode: { type: String, default: null },
  // Cache of the live-joined receivable/payable this debit note increased —
  // resolved at allocate-time (same "cache of a live join, not the
  // authority" discipline as CreditNoteModel.arReceivableId).
  arReceivableId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "accounts_receivable",
    default: null
  },
  apPayableId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "accounts_payable",
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
  allocatedBy: { type: String, default: null },
  allocatedAt: { type: Date, default: null },
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

DebitNoteSchema.index({ tenantId: 1, debitNumber: 1 }, { unique: true });
DebitNoteSchema.index({ tenantId: 1, invoiceId: 1 });
DebitNoteSchema.index({ tenantId: 1, payableId: 1 });
DebitNoteSchema.index({ tenantId: 1, customerId: 1, status: 1 });
DebitNoteSchema.index({ tenantId: 1, vendorId: 1, status: 1 });

DebitNoteSchema.set("toJSON", {
  transform: (_, ret) => {
    delete ret.__v;
    return ret;
  }
});

const DebitNoteModel = mongoose.model("debit_note", DebitNoteSchema);

export default DebitNoteModel;
