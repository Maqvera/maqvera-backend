import mongoose from "mongoose";

// Enterprise Invoices — Finance Module Part 9. "An invoice is much more
// than a PDF. It is a financial contract." Tenant-scoped only — no
// branchId (see docs/06-external-integrations/03-final-architecture-no-branches-rbac.md).
//
// `outstandingBalance` is deliberately NOT stored here — it's computed at
// read time from the linked Accounts Receivable record (once one exists,
// after Issue) via InvoiceService, the same "never trust a cached copy
// when the source of truth is one query away" discipline already applied
// to the Ledger (Part 4). `arReceivableId` is a lazily-resolved cache of
// that join, not the authority.
const InvoiceLineItemSchema = new mongoose.Schema({
  description: { type: String, required: true },
  quantity: { type: Number, required: true, min: 0.01 },
  unitPrice: { type: Number, required: true, min: 0 },
  // Finance Module Part 21 — optional. When the request line supplies a
  // `productCode` (no Product/Catalog model exists in this codebase; a
  // plain opaque SKU string, same treatment as `taxCode`), InvoiceService
  // resolves `unitPrice`/the effective discount through the real
  // centralized `PricingService.resolveLinePrice` before this document is
  // ever built — `productCode` itself is stored here purely as a
  // denormalized record of which product the resolution was for, never
  // re-resolved later. A line with no `productCode` keeps working exactly
  // as before this Part existed (caller-supplied `unitPrice`/`discountType`/
  // `discountValue` directly).
  productCode: { type: String, default: null },
  taxCode: { type: String, default: null },
  discountType: { type: String, enum: ["Percentage", "Flat"], default: null },
  discountValue: { type: Number, default: 0 },
  // Computed and stored at save time (InvoiceService.computeLineTotals) —
  // denormalized so a historical version snapshot shows exactly what was
  // billed, even if tax rates configuration changes later.
  lineSubtotal: { type: Number, required: true },
  lineDiscountAmount: { type: Number, required: true, default: 0 },
  lineTaxAmount: { type: Number, required: true, default: 0 },
  lineTotal: { type: Number, required: true }
}, { _id: true });

const InvoiceSchema = new mongoose.Schema({
  tenantId: {
    type: String,
    required: true,
    index: true
  },
  // Immutable once assigned — generated server-side, never caller-supplied.
  invoiceNumber: {
    type: String,
    required: true,
    immutable: true
  },
  // Config-driven (invoiceTypes) — Commercial, Tax, Proforma, Recurring,
  // Deposit, Installment, Credit, Debit, Subscription, Custom.
  invoiceType: {
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
  // Config-driven (invoiceStatuses) — Draft, Pending Approval, Approved,
  // Issued, Partially Paid, Paid, Closed, Cancelled, Voided, Written Off,
  // Disputed.
  status: {
    type: String,
    required: true,
    index: true
  },
  currency: {
    type: String,
    required: true
  },
  issueDate: {
    type: Date,
    required: true
  },
  dueDate: {
    type: Date,
    required: true,
    index: true
  },
  items: {
    type: [InvoiceLineItemSchema],
    validate: {
      validator: (items) => Array.isArray(items) && items.length >= 1,
      message: "An invoice requires at least one line item."
    }
  },
  subtotal: { type: Number, required: true },
  taxTotal: { type: Number, required: true },
  discountTotal: { type: Number, required: true },
  grandTotal: { type: Number, required: true },
  // "Invoice Versioning... Historical versions preserved." Snapshotted on
  // every PATCH to a Draft invoice, before the new values are applied.
  version: { type: Number, default: 1 },
  versionHistory: [{
    version: { type: Number, required: true },
    snapshot: { type: mongoose.Schema.Types.Mixed, required: true },
    changedAt: { type: Date, default: Date.now },
    changedBy: { type: String, default: null },
    reason: { type: String, default: null }
  }],
  // Resolved lazily by InvoiceService's payment-status-sync listener the
  // first time an AR event for this invoice's receivable arrives — not set
  // at Issue time directly (AR creates the receivable asynchronously, via
  // the InvoiceCreated event, so there's no return value to capture here).
  arReceivableId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "accounts_receivable",
    default: null
  },
  pdf: {
    url: { type: String, default: null },
    storageKey: { type: String, default: null },
    storageProvider: { type: String, default: null },
    generatedAt: { type: Date, default: null }
  },
  attachments: [{
    url: { type: String, required: true },
    filename: { type: String, default: null },
    contentType: { type: String, default: null },
    uploadedBy: { type: String, default: null },
    uploadedAt: { type: Date, default: Date.now }
  }],
  notes: { type: String, default: null },
  // "Credit Notes" — structurally present for when that module ships
  // (Part 10, next); functionally empty until then, same placeholder
  // pattern as AR/AP.
  creditNoteIds: [{ type: mongoose.Schema.Types.ObjectId, ref: "credit_note" }],
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

InvoiceSchema.index({ tenantId: 1, invoiceNumber: 1 }, { unique: true });
InvoiceSchema.index({ tenantId: 1, customerId: 1, status: 1 });
InvoiceSchema.index({ tenantId: 1, status: 1, dueDate: 1 });

InvoiceSchema.set("toJSON", {
  transform: (_, ret) => {
    delete ret.__v;
    return ret;
  }
});

const InvoiceModel = mongoose.model("invoice", InvoiceSchema);

export default InvoiceModel;
