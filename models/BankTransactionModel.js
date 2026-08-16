import mongoose from "mongoose";

// The real, append-only backing record for "Immutable Transaction History"
// (AI Coding Rule) and the `BalanceUpdated` domain event — Finance Module
// Part 13. Every balance mutation on a BankAccountModel (Payment/Refund
// settlement, manual adjustment, hold/release) writes exactly one of these
// first; `BankAccountModel.balances` is a running total kept in sync by
// this ledger, never mutated independently of it (same discipline as
// Journal/Ledger's own append-only posting record for GL accounts). Also
// what Part 14 (Bank Reconciliation) will match imported bank-statement
// lines against.
const BankTransactionSchema = new mongoose.Schema({
  tenantId: {
    type: String,
    required: true,
    index: true
  },
  bankAccountId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "bank_account",
    required: true,
    index: true
  },
  transactionNumber: {
    type: String,
    required: true,
    immutable: true
  },
  // Credit = money in, Debit = money out (accounting convention for an
  // asset account: a Credit here mirrors a Debit to the bank's own GL
  // control account, and vice versa).
  direction: {
    type: String,
    enum: ["Credit", "Debit"],
    required: true
  },
  amount: {
    type: Number,
    required: true,
    min: 0.01
  },
  currency: {
    type: String,
    required: true
  },
  // Running balance snapshot immediately after this transaction posted —
  // immutable once written, giving a real point-in-time audit trail
  // independent of the account's own current `balances.current`.
  balanceAfter: {
    type: Number,
    required: true
  },
  // Payment | Refund | ManualAdjustment | OpeningBalance | Hold | ReleaseHold.
  type: {
    type: String,
    required: true,
    index: true
  },
  // Polymorphic link back to whatever caused this movement (a Payment, a
  // Refund, ...) — same no-`ref` discipline as PaymentModel.allocations'
  // own targetType/targetId (spans several different collections; callers
  // resolve by targetType themselves).
  sourceType: { type: String, default: null },
  sourceId: { type: mongoose.Schema.Types.ObjectId, default: null },
  description: { type: String, default: null },
  performedBy: { type: String, default: null }
}, { timestamps: true });

BankTransactionSchema.index({ tenantId: 1, transactionNumber: 1 }, { unique: true });
BankTransactionSchema.index({ tenantId: 1, bankAccountId: 1, createdAt: -1 });
BankTransactionSchema.index({ tenantId: 1, sourceType: 1, sourceId: 1 });

BankTransactionSchema.set("toJSON", {
  transform: (_, ret) => {
    delete ret.__v;
    return ret;
  }
});

const BankTransactionModel = mongoose.model("bank_transaction", BankTransactionSchema);

export default BankTransactionModel;
