import mongoose from "mongoose";

// One row per line imported from a bank statement (Finance Module Part 14)
// — kept as its own collection, separate from BankReconciliationModel,
// since a statement can carry hundreds of lines each needing independent
// match-state queries (matched/unmatched/exception filters), the same
// "large/independently-queryable set gets its own collection" reasoning
// already applied to BankTransactionModel (Part 13) vs. embedding
// transactions on the bank account itself.
const BankStatementTransactionSchema = new mongoose.Schema({
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
  // The bank's own reference for this line, when the source format
  // carries one (MT940 has none per line; CAMT.053's NtryRef; OFX's
  // FITID; a caller-supplied id for CSV/Excel/Custom) — null otherwise.
  externalTransactionId: { type: String, default: null },
  transactionDate: { type: Date, required: true, index: true },
  valueDate: { type: Date, default: null },
  direction: { type: String, enum: ["Credit", "Debit"], required: true },
  amount: { type: Number, required: true },
  currency: { type: String, required: true },
  reference: { type: String, default: null },
  // The original record exactly as parsed (raw CSV row as JSON, the MT940
  // :61:/:86: tag text, the CAMT.053 <Ntry> as JSON, ...) — real,
  // unmodified audit trail back to the source file.
  rawLine: { type: String, default: null },
  matchStatus: {
    type: String,
    enum: ["Unmatched", "Matched", "Ignored"],
    default: "Unmatched",
    index: true
  },
  // The ERP-side ledger entry (Part 13's own BankTransactionModel) this
  // line was matched to.
  matchedBankTransactionId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "bank_transaction",
    default: null
  },
  // 0-100 weighted score (BankReconciliationService.computeMatchScore) —
  // null for a manual match, since no scoring was involved.
  matchScore: { type: Number, default: null },
  matchMethod: { type: String, enum: ["Auto", "Manual", "AI-Suggested"], default: null },
  matchedBy: { type: String, default: null },
  matchedAt: { type: Date, default: null }
}, { timestamps: true });

BankStatementTransactionSchema.index({ tenantId: 1, reconciliationId: 1, matchStatus: 1 });
BankStatementTransactionSchema.index({ tenantId: 1, bankAccountId: 1, transactionDate: 1 });

BankStatementTransactionSchema.set("toJSON", {
  transform: (_, ret) => {
    delete ret.__v;
    return ret;
  }
});

const BankStatementTransactionModel = mongoose.model("bank_statement_transaction", BankStatementTransactionSchema);

export default BankStatementTransactionModel;
