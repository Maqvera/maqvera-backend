import mongoose from "mongoose";

// The real, append-only backing record for "Immutable Cash History" (AI
// Coding Rule) — Finance Module Part 15. Mirrors Part 13's own
// BankTransactionModel design exactly (same append-only ledger discipline,
// same fields), built as its own separate collection rather than reusing
// that one — "Cash != Bank," different audit requirements, and mixing the
// two ledgers would make "is this money physical cash or bank funds"
// unanswerable from the record alone.
const CashTransactionSchema = new mongoose.Schema({
  tenantId: {
    type: String,
    required: true,
    index: true
  },
  cashLocationId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "cash_location",
    required: true,
    index: true
  },
  transactionNumber: {
    type: String,
    required: true,
    immutable: true
  },
  // Credit = cash in, Debit = cash out.
  direction: {
    type: String,
    enum: ["Credit", "Debit"],
    required: true
  },
  amount: { type: Number, required: true, min: 0.01 },
  currency: { type: String, required: true },
  balanceAfter: { type: Number, required: true },
  // OpeningBalance | TransferIn | TransferOut | PettyCashAdvanceIssued |
  // PettyCashAdvanceSettled | PettyCashReplenishment | PettyCashExpense |
  // CountVarianceAdjustment | ManualAdjustment.
  type: { type: String, required: true, index: true },
  // Polymorphic link back to whatever caused this movement (a
  // CashTransferModel, a PettyCashAdvanceModel, a CashCountModel, ...) —
  // same no-`ref` discipline as PaymentModel.allocations'/
  // BankTransactionModel's own sourceType/sourceId.
  sourceType: { type: String, default: null },
  sourceId: { type: mongoose.Schema.Types.ObjectId, default: null },
  description: { type: String, default: null },
  performedBy: { type: String, default: null }
}, { timestamps: true });

CashTransactionSchema.index({ tenantId: 1, transactionNumber: 1 }, { unique: true });
CashTransactionSchema.index({ tenantId: 1, cashLocationId: 1, createdAt: -1 });
CashTransactionSchema.index({ tenantId: 1, sourceType: 1, sourceId: 1 });

CashTransactionSchema.set("toJSON", {
  transform: (_, ret) => {
    delete ret.__v;
    return ret;
  }
});

const CashTransactionModel = mongoose.model("cash_transaction", CashTransactionSchema);

export default CashTransactionModel;
