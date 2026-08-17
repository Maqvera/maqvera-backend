import mongoose from "mongoose";

// Enterprise Bank Reconciliation — Finance Module Part 14. "Does the money
// in our ERP match the money shown by the bank?" Tenant-scoped only — no
// branchId (see docs/06-external-integrations/03-final-architecture-no-branches-rbac.md;
// the spec's own "Branch Match" validation rule is dropped per the standing
// master instructions — see docs/05-api/07-finance-api.md Part 14).
//
// One document per imported bank statement ("reconciliation session").
// `erpBalance` is a snapshot of the linked BankAccountModel's own
// `balances.current` taken at import time — the real "ERP Balance" half of
// the user's own worked example; `difference` (`closingBalance - erpBalance`)
// is recalculated every time a match/unmatch/adjustment changes anything.
const ReconciliationAdjustmentSchema = new mongoose.Schema({
  // The real BankTransactionModel entry BankAccountService.manualAdjustment
  // (Part 13) created for this adjustment — this module never mutates a
  // bank account's balance directly, it always goes through that existing,
  // real, journal-posting primitive.
  bankTransactionId: { type: mongoose.Schema.Types.ObjectId, ref: "bank_transaction", required: true },
  journalId: { type: mongoose.Schema.Types.ObjectId, ref: "journal", default: null },
  direction: { type: String, enum: ["Credit", "Debit"], required: true },
  amount: { type: Number, required: true },
  // BankCharge | InterestIncome | FxGainLoss | Correction
  adjustmentType: { type: String, required: true },
  reason: { type: String, required: true },
  // Set when this adjustment was created specifically to resolve a
  // BankReconciliationExceptionModel row.
  exceptionId: { type: mongoose.Schema.Types.ObjectId, ref: "bank_reconciliation_exception", default: null },
  createdBy: { type: String, default: null },
  createdAt: { type: Date, default: Date.now }
}, { _id: true });

const BankReconciliationSchema = new mongoose.Schema({
  tenantId: {
    type: String,
    required: true,
    index: true
  },
  reconciliationNumber: {
    type: String,
    required: true,
    immutable: true
  },
  bankAccountId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "bank_account",
    required: true,
    index: true
  },
  statementDate: {
    type: Date,
    required: true
  },
  currency: {
    type: String,
    required: true
  },
  // Config-driven (reconciliationImportFormats) — CSV, Excel, MT940,
  // CAMT.053, OFX, Custom.
  sourceFormat: {
    type: String,
    required: true
  },
  openingBalance: { type: Number, required: true },
  closingBalance: { type: Number, required: true },
  erpBalance: { type: Number, required: true },
  difference: { type: Number, required: true },
  matchedCount: { type: Number, default: 0 },
  unmatchedCount: { type: Number, default: 0 },
  exceptionCount: { type: Number, default: 0 },
  // Config-driven (reconciliationStatuses) — Manual Review, Approved,
  // Completed, Rejected, Archived. See utils/financeConfig.js's own doc
  // comment for why "Statement Imported"/"Auto Matching"/"Reopened" aren't
  // resting status values here.
  status: {
    type: String,
    required: true,
    index: true
  },
  // The raw uploaded statement file, archived for audit purposes via the
  // same generic buffer-storage bridge (utils/documentPdfStorage.js)
  // already used by every server-generated Finance PDF this session — here
  // storing a caller-uploaded file instead of a generated one, the same
  // storage abstraction either way. Null for the "Custom" JSON-passthrough
  // format submitted inline with no separate file.
  statementFile: {
    url: { type: String, default: null },
    storageKey: { type: String, default: null },
    storageProvider: { type: String, default: null }
  },
  adjustments: [ReconciliationAdjustmentSchema],
  approvedBy: { type: String, default: null },
  approvedAt: { type: Date, default: null },
  completedBy: { type: String, default: null },
  completedAt: { type: Date, default: null },
  rejectedBy: { type: String, default: null },
  rejectedAt: { type: Date, default: null },
  rejectionReason: { type: String, default: null },
  archivedBy: { type: String, default: null },
  archivedAt: { type: Date, default: null },
  timeline: [{
    event: { type: String, required: true },
    description: { type: String, default: null },
    performedBy: { type: String, default: null },
    performedAt: { type: Date, default: Date.now }
  }],
  createdBy: { type: String, default: null },
  updatedBy: { type: String, default: null }
}, { timestamps: true });

BankReconciliationSchema.index({ tenantId: 1, reconciliationNumber: 1 }, { unique: true });
// "Duplicate Detection" (Validation Rules) — one reconciliation session per
// bank account per statement date; a genuine re-import requires rejecting
// or archiving the prior one first, rather than silently allowing two
// sessions to both claim the same statement date.
BankReconciliationSchema.index({ tenantId: 1, bankAccountId: 1, statementDate: 1 }, { unique: true });
BankReconciliationSchema.index({ tenantId: 1, status: 1 });

BankReconciliationSchema.set("toJSON", {
  transform: (_, ret) => {
    delete ret.__v;
    return ret;
  }
});

const BankReconciliationModel = mongoose.model("bank_reconciliation", BankReconciliationSchema);

export default BankReconciliationModel;
