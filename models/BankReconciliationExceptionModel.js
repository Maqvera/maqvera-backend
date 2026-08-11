import mongoose from "mongoose";

// Real "Exception Management" (Finance Module Part 14) — a dedicated,
// queryable, resolvable record per discrepancy, not just an inline status
// label. `statementTransactionId` is null for a MissingBankEntry (the ERP
// has a transaction the statement never shows); `bankTransactionId` is null
// for a MissingERPEntry (the statement shows a transaction with nothing on
// the ERP side to match it) — exactly one of the two is ever null, never
// both, since every exception concerns at least one real side.
const BankReconciliationExceptionSchema = new mongoose.Schema({
  tenantId: {
    type: String,
    required: true,
    index: true
  },
  reconciliationId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "bank_reconciliation",
    required: true,
    index: true
  },
  bankAccountId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "bank_account",
    required: true,
    index: true
  },
  // Duplicate | MissingERPEntry | MissingBankEntry | AmountDifference |
  // CurrencyDifference | ReferenceMismatch | LateSettlement.
  exceptionType: {
    type: String,
    required: true,
    index: true
  },
  statementTransactionId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "bank_statement_transaction",
    default: null
  },
  bankTransactionId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "bank_transaction",
    default: null
  },
  amount: { type: Number, default: null },
  currency: { type: String, default: null },
  description: { type: String, default: null },
  status: {
    type: String,
    enum: ["Open", "Resolved", "Ignored"],
    default: "Open",
    index: true
  },
  // AdjustmentCreated | MarkedDuplicate | ManuallyMatched | Ignored | Other
  resolutionAction: { type: String, default: null },
  resolutionNotes: { type: String, default: null },
  resolvedBy: { type: String, default: null },
  resolvedAt: { type: Date, default: null },
  timeline: [{
    event: { type: String, required: true },
    description: { type: String, default: null },
    performedBy: { type: String, default: null },
    performedAt: { type: Date, default: Date.now }
  }],
  createdBy: { type: String, default: null }
}, { timestamps: true });

BankReconciliationExceptionSchema.index({ tenantId: 1, reconciliationId: 1, status: 1 });
BankReconciliationExceptionSchema.index({ tenantId: 1, bankAccountId: 1, status: 1 });

BankReconciliationExceptionSchema.set("toJSON", {
  transform: (_, ret) => {
    delete ret.__v;
    return ret;
  }
});

const BankReconciliationExceptionModel = mongoose.model("bank_reconciliation_exception", BankReconciliationExceptionSchema);

export default BankReconciliationExceptionModel;
