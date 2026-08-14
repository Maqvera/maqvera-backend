import mongoose from "mongoose";

// "Every wallet transaction is immutable." Finance Module Part 18 Part 4.
// Append-only ledger — nothing here is ever updated or deleted after
// creation, mirroring PaymentModel's own immutable-history discipline.
// `balanceAfter` is a real snapshot taken at write time (never
// recomputed), so a historical statement reads correctly even if later
// transactions change the wallet's current balance.
const WalletTransactionSchema = new mongoose.Schema({
  tenantId: {
    type: String,
    required: true,
    index: true
  },
  walletId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "wallet",
    required: true,
    index: true
  },
  // Config-driven (walletTransactionTypes) — TopUp, Purchase, Refund,
  // TransferOut, TransferIn, Withdrawal.
  type: {
    type: String,
    required: true,
    index: true
  },
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
  balanceAfter: {
    type: Number,
    required: true
  },
  currency: {
    type: String,
    required: true
  },
  // Real, resolved cross-references — never a bare free-text note. Only
  // the one relevant to this transaction's own `type` is ever populated.
  paymentId: { type: mongoose.Schema.Types.ObjectId, ref: "payment", default: null },
  collectionId: { type: mongoose.Schema.Types.ObjectId, ref: "customer_collection", default: null },
  counterpartyWalletId: { type: mongoose.Schema.Types.ObjectId, ref: "wallet", default: null },
  description: { type: String, default: null },
  performedBy: { type: String, default: null }
}, { timestamps: true });

WalletTransactionSchema.index({ tenantId: 1, walletId: 1, createdAt: -1 });

WalletTransactionSchema.set("toJSON", {
  transform: (_, ret) => {
    delete ret.__v;
    return ret;
  }
});

const WalletTransactionModel = mongoose.model("wallet_transaction", WalletTransactionSchema);

export default WalletTransactionModel;
