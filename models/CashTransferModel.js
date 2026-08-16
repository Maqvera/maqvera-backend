import mongoose from "mongoose";

// Cash Transfers — Finance Module Part 15. Also the real mechanism behind
// "Safe & Vault... Cash Deposit, Cash Withdrawal" (a deposit into a Safe/
// Vault-typed location, or a withdrawal from one, IS a transfer where one
// side is that location — no separate deposit/withdrawal endpoint
// duplicates this).
const CashTransferSchema = new mongoose.Schema({
  tenantId: {
    type: String,
    required: true,
    index: true
  },
  transferNumber: {
    type: String,
    required: true,
    immutable: true
  },
  fromLocationId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "cash_location",
    required: true,
    index: true
  },
  toLocationId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "cash_location",
    required: true,
    index: true
  },
  amount: { type: Number, required: true, min: 0.01 },
  currency: { type: String, required: true },
  reason: { type: String, default: null },
  // Config-driven (cashTransferStatuses) — Pending Approval, Approved,
  // Completed, Rejected, Cancelled.
  status: {
    type: String,
    required: true,
    index: true
  },
  // Set at creation from either location's own `dualAuthorizationRequired`
  // flag — a transfer touching a Safe/Vault (or any location an admin has
  // flagged) needs TWO different users' approvals, not the usual single
  // gate.
  requiresDualAuthorization: { type: Boolean, default: false },
  approvals: [{
    approvedBy: { type: String, required: true },
    approvedAt: { type: Date, default: Date.now }
  }],
  // The two real CashTransactionModel ledger rows this transfer produced
  // once completed (the debit from `fromLocationId`, the credit to
  // `toLocationId`).
  fromTransactionId: { type: mongoose.Schema.Types.ObjectId, ref: "cash_transaction", default: null },
  toTransactionId: { type: mongoose.Schema.Types.ObjectId, ref: "cash_transaction", default: null },
  journalId: { type: mongoose.Schema.Types.ObjectId, ref: "journal", default: null },
  completedAt: { type: Date, default: null },
  rejectedBy: { type: String, default: null },
  rejectedAt: { type: Date, default: null },
  rejectionReason: { type: String, default: null },
  cancelledBy: { type: String, default: null },
  cancelledAt: { type: Date, default: null },
  cancellationReason: { type: String, default: null },
  timeline: [{
    event: { type: String, required: true },
    description: { type: String, default: null },
    performedBy: { type: String, default: null },
    performedAt: { type: Date, default: Date.now }
  }],
  createdBy: { type: String, default: null },
  updatedBy: { type: String, default: null }
}, { timestamps: true });

CashTransferSchema.index({ tenantId: 1, transferNumber: 1 }, { unique: true });
CashTransferSchema.index({ tenantId: 1, status: 1 });
CashTransferSchema.index({ tenantId: 1, fromLocationId: 1 });
CashTransferSchema.index({ tenantId: 1, toLocationId: 1 });

CashTransferSchema.set("toJSON", {
  transform: (_, ret) => {
    delete ret.__v;
    return ret;
  }
});

const CashTransferModel = mongoose.model("cash_transfer", CashTransferSchema);

export default CashTransferModel;
