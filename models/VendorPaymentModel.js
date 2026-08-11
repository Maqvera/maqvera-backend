import mongoose from "mongoose";

// Enterprise Vendor Payments — Finance Module Part 17. "Payment Engine
// moves money. Vendor Payment Platform decides which vendor, which
// invoices, which bank account, which date, which approval, which payment
// file." This model is the real decision/orchestration record — it never
// stores money-movement logic itself, only what to move, when, and via
// what; the actual movement always happens through Part 7's own
// PaymentModel (`paymentId` below) and Part 6's own AccountsPayableModel
// allocations. Tenant-scoped only — no branchId (see
// docs/06-external-integrations/03-final-architecture-no-branches-rbac.md;
// the spec's own "Branch Match" language is dropped per the standing
// master instructions — see docs/05-api/07-finance-api.md Part 17).
const VendorPaymentLineSchema = new mongoose.Schema({
  payableId: { type: mongoose.Schema.Types.ObjectId, ref: "accounts_payable", required: true },
  invoiceNumber: { type: String, required: true },
  amount: { type: Number, required: true, min: 0.01 }
}, { _id: false });

const VendorPaymentSchema = new mongoose.Schema({
  tenantId: {
    type: String,
    required: true,
    index: true
  },
  vendorPaymentNumber: {
    type: String,
    required: true,
    immutable: true
  },
  vendorId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "vendor",
    required: true,
    index: true
  },
  vendorName: { type: String, default: null },
  lineAllocations: {
    type: [VendorPaymentLineSchema],
    validate: {
      validator: (lines) => Array.isArray(lines) && lines.length >= 1,
      message: "A vendor payment requires at least one invoice line."
    }
  },
  totalAmount: { type: Number, required: true },
  currency: { type: String, required: true },
  // The company's own paying account (Part 13).
  bankAccountId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "bank_account",
    required: true
  },
  // Which of the vendor's own bank accounts (VendorModel.bankAccounts[])
  // this payment is sent to — the embedded subdocument's own _id.
  vendorBankAccountId: { type: mongoose.Schema.Types.ObjectId, default: null },
  paymentDate: { type: Date, required: true },
  // Reuses utils/financeConfig.js's own existing paymentPriorities
  // (Part 6) rather than a near-duplicate list.
  priority: { type: String, default: null },
  // Config-driven (vendorPaymentStatuses) — Proposed, Approved, Scheduled,
  // Executing, Completed, Rejected, Cancelled, Failed, On Hold. See
  // utils/financeConfig.js's own doc comment for why "Pending Approval"
  // isn't a separate resting status.
  status: {
    type: String,
    required: true,
    index: true
  },
  // "Dual Approval" — set at creation from whether totalAmount reaches
  // vendorPaymentDualApprovalThreshold; same ordered/count-based design as
  // Part 15's CashTransferModel.
  requiresDualApproval: { type: Boolean, default: false },
  approvals: [{
    approvedBy: { type: String, required: true },
    approvedAt: { type: Date, default: Date.now }
  }],
  // The real Payment Engine record (Part 7) this proposal executed
  // through, once it does.
  paymentId: { type: mongoose.Schema.Types.ObjectId, ref: "payment", default: null },
  executionResult: {
    gatewayStatus: { type: String, default: null },
    transactionId: { type: String, default: null },
    failureReason: { type: String, default: null },
    // Real, honest record of a partial-failure edge case: the Payment
    // Engine capture succeeded (money genuinely moved) but one or more
    // individual AccountsPayableService.allocatePayment calls failed —
    // the vendor payment is still "Completed" (cash left the account),
    // this just flags which invoice line(s) need manual reconciliation.
    allocationWarnings: [{ payableId: mongoose.Schema.Types.ObjectId, error: String }]
  },
  journalId: { type: mongoose.Schema.Types.ObjectId, ref: "journal", default: null },
  fileGeneration: {
    format: { type: String, default: null },
    generatedAt: { type: Date, default: null },
    url: { type: String, default: null },
    storageKey: { type: String, default: null },
    storageProvider: { type: String, default: null }
  },
  batchId: { type: mongoose.Schema.Types.ObjectId, ref: "payment_batch", default: null },
  proposedBy: { type: String, default: null },
  proposedAt: { type: Date, default: null },
  approvedAt: { type: Date, default: null },
  scheduledAt: { type: Date, default: null },
  executedAt: { type: Date, default: null },
  completedAt: { type: Date, default: null },
  rejectedBy: { type: String, default: null },
  rejectedAt: { type: Date, default: null },
  rejectionReason: { type: String, default: null },
  cancelledBy: { type: String, default: null },
  cancelledAt: { type: Date, default: null },
  cancellationReason: { type: String, default: null },
  holdReason: { type: String, default: null },
  heldBy: { type: String, default: null },
  heldAt: { type: Date, default: null },
  timeline: [{
    event: { type: String, required: true },
    description: { type: String, default: null },
    performedBy: { type: String, default: null },
    performedAt: { type: Date, default: Date.now }
  }],
  createdBy: { type: String, default: null },
  updatedBy: { type: String, default: null }
}, { timestamps: true });

VendorPaymentSchema.index({ tenantId: 1, vendorPaymentNumber: 1 }, { unique: true });
VendorPaymentSchema.index({ tenantId: 1, vendorId: 1, status: 1 });
VendorPaymentSchema.index({ tenantId: 1, status: 1 });
VendorPaymentSchema.index({ tenantId: 1, paymentDate: 1 });

VendorPaymentSchema.set("toJSON", {
  transform: (_, ret) => {
    delete ret.__v;
    return ret;
  }
});

const VendorPaymentModel = mongoose.model("vendor_payment_run", VendorPaymentSchema);

export default VendorPaymentModel;
