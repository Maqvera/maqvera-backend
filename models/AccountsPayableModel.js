import mongoose from "mongoose";

// Accounts Payable — Finance Module Part 6, the mirror image of Accounts
// Receivable (Part 5): "Vendor Invoice -> We Pay Supplier -> Balance
// becomes 0." Tenant-scoped only — no branchId (see
// docs/06-external-integrations/03-final-architecture-no-branches-rbac.md).
//
// `vendorId`/`vendorName` mirror AR's customerId/customerName snapshot
// pattern. Unlike AR, this module has an approval gate before a payable is
// payable at all (see utils/financeConfig.js payableStatuses) — no Overdue/
// In-Collection states, since vendor aging is a live read here, not a
// status transition (see services/AccountsPayableService.js).
const AccountsPayableSchema = new mongoose.Schema({
  tenantId: {
    type: String,
    required: true,
    index: true
  },
  vendorId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "vendor",
    required: true,
    index: true
  },
  vendorName: {
    type: String,
    required: true
  },
  invoiceNumber: {
    type: String,
    required: true
  },
  invoiceDate: {
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
  // Config-driven (utils/financeConfig.js payableStatuses) — Draft, Pending
  // Approval, Approved, Open, Partially Paid, Paid, Settled, Cancelled,
  // Disputed, Written Off.
  status: {
    type: String,
    required: true,
    index: true
  },
  approvedBy: { type: String, default: null },
  approvedAt: { type: Date, default: null },
  // "Payment Scheduling" — planning/visibility metadata (Cash Flow
  // Planning is a deferred reporting feature, not an execution engine).
  scheduledPayment: {
    date: { type: Date, default: null },
    priority: { type: String, default: null } // config-driven paymentPriorities
  },
  // "Payment History."
  allocations: [{
    paymentId: { type: mongoose.Schema.Types.ObjectId, ref: "vendor_payment", required: true },
    amount: { type: Number, required: true },
    journalId: { type: mongoose.Schema.Types.ObjectId, ref: "journal", default: null },
    allocatedAt: { type: Date, default: Date.now },
    allocatedBy: { type: String, default: null }
  }],
  // "Adjustments" — write-offs, manual corrections, and auto-applied vendor
  // advances (Advance Payments: "linked automatically when invoice arrives").
  adjustments: [{
    type: { type: String, required: true }, // WriteOff | ManualAdjustment | AdvanceApplied | CreditNoteApplied | DebitNoteApplied
    amount: { type: Number, required: true },
    reason: { type: String, default: null },
    performedBy: { type: String, default: null },
    performedAt: { type: Date, default: Date.now }
  }],
  // "Credit Notes" — structurally present for when that module ships;
  // functionally empty until then (mirrors AR's creditNoteIds).
  creditNoteIds: [{ type: mongoose.Schema.Types.ObjectId, ref: "credit_note" }],
  // "Debit Notes" — Finance Module Part 11, mirror of creditNoteIds above.
  debitNoteIds: [{ type: mongoose.Schema.Types.ObjectId, ref: "debit_note" }],
  writeOff: {
    isWrittenOff: { type: Boolean, default: false },
    writeOffType: { type: String, default: null }, // SmallBalance | VendorWaiver | AccountingAdjustment
    reason: { type: String, default: null },
    approvedBy: { type: String, default: null },
    approvedAt: { type: Date, default: null },
    journalId: { type: mongoose.Schema.Types.ObjectId, ref: "journal", default: null }
  },
  timeline: [{
    event: { type: String, required: true },
    description: { type: String, default: null },
    performedBy: { type: String, default: null },
    performedAt: { type: Date, default: Date.now }
  }],
  createdBy: { type: String, default: null },
  updatedBy: { type: String, default: null }
}, { timestamps: true });

AccountsPayableSchema.index({ tenantId: 1, invoiceNumber: 1 }, { unique: true });
AccountsPayableSchema.index({ tenantId: 1, vendorId: 1, status: 1 });
AccountsPayableSchema.index({ tenantId: 1, status: 1, dueDate: 1 });

AccountsPayableSchema.set("toJSON", {
  transform: (_, ret) => {
    delete ret.__v;
    return ret;
  }
});

const AccountsPayableModel = mongoose.model("accounts_payable", AccountsPayableSchema);

export default AccountsPayableModel;
