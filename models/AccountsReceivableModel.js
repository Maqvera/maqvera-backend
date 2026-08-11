import mongoose from "mongoose";

// Accounts Receivable — Finance Module Part 5. "An Invoice is just a
// financial document. Accounts Receivable manages everything the customer
// still owes you." Tenant-scoped only — no branchId (see
// docs/06-external-integrations/03-final-architecture-no-branches-rbac.md).
//
// `invoiceId`/`invoiceNumber` reference the future Invoice module (Part 7,
// not yet built) — see AccountsReceivableService for how a receivable gets
// created today (manual creation now; InvoiceCreated event subscription
// wired and ready for when Part 7 ships).
const AccountsReceivableSchema = new mongoose.Schema({
  tenantId: {
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
  // Denormalized snapshot — Customer is not Finance-owned (Part 1), so this
  // avoids a join for every list response while the FK above keeps the
  // relationship real and queryable both ways.
  customerName: {
    type: String,
    required: true
  },
  invoiceId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "invoice",
    default: null
  },
  invoiceNumber: {
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
  originalAmount: {
    type: Number,
    required: true,
    min: 0.01
  },
  paidAmount: {
    type: Number,
    default: 0
  },
  outstandingBalance: {
    type: Number,
    required: true
  },
  currency: {
    type: String,
    required: true
  },
  // Config-driven (utils/financeConfig.js receivableStatuses) — Draft,
  // Open, Partially Paid, Paid, Overdue, In Collection, Settled, Written
  // Off, Cancelled, Disputed.
  status: {
    type: String,
    required: true,
    index: true
  },
  // Config-driven (collectionStages) — null until services/receivableOverdueScheduler.js
  // first escalates an Overdue receivable into collection.
  collectionStage: {
    type: String,
    default: null
  },
  // "Payment History" — appended to by allocate-payment; never edited after
  // the fact, mirroring the Ledger's append-only spirit for financial trails.
  allocations: [{
    paymentId: { type: mongoose.Schema.Types.ObjectId, ref: "payment", required: true },
    amount: { type: Number, required: true },
    journalId: { type: mongoose.Schema.Types.ObjectId, ref: "journal", default: null },
    allocatedAt: { type: Date, default: Date.now },
    allocatedBy: { type: String, default: null }
  }],
  // "Adjustments" — write-offs and manual corrections against this
  // receivable's balance, distinct from a payment allocation.
  adjustments: [{
    type: { type: String, required: true }, // WriteOff | ManualAdjustment | CreditNoteApplied | CreditApplied | DebitNoteApplied
    amount: { type: Number, required: true },
    reason: { type: String, default: null },
    performedBy: { type: String, default: null },
    performedAt: { type: Date, default: Date.now }
  }],
  // "Credit Notes" — structurally present for when that module ships;
  // functionally empty until then (no Credit Note module exists yet).
  creditNoteIds: [{ type: mongoose.Schema.Types.ObjectId, ref: "credit_note" }],
  // "Debit Notes" — Finance Module Part 11, mirror of creditNoteIds above.
  debitNoteIds: [{ type: mongoose.Schema.Types.ObjectId, ref: "debit_note" }],
  writeOff: {
    isWrittenOff: { type: Boolean, default: false },
    writeOffType: { type: String, default: null }, // SmallBalance | BadDebt
    reason: { type: String, default: null },
    approvedBy: { type: String, default: null },
    approvedAt: { type: Date, default: null },
    journalId: { type: mongoose.Schema.Types.ObjectId, ref: "journal", default: null }
  },
  // "Timeline" — embedded, matching this codebase's existing pattern of a
  // per-document timeline array (e.g. VisaCaseModel.timeline) rather than a
  // separate collection for a resource this size.
  timeline: [{
    event: { type: String, required: true },
    description: { type: String, default: null },
    performedBy: { type: String, default: null },
    performedAt: { type: Date, default: Date.now }
  }],
  createdBy: { type: String, default: null },
  updatedBy: { type: String, default: null }
}, { timestamps: true });

AccountsReceivableSchema.index({ tenantId: 1, invoiceNumber: 1 }, { unique: true });
AccountsReceivableSchema.index({ tenantId: 1, customerId: 1, status: 1 });
AccountsReceivableSchema.index({ tenantId: 1, status: 1, dueDate: 1 });

AccountsReceivableSchema.set("toJSON", {
  transform: (_, ret) => {
    delete ret.__v;
    return ret;
  }
});

const AccountsReceivableModel = mongoose.model("accounts_receivable", AccountsReceivableSchema);

export default AccountsReceivableModel;
