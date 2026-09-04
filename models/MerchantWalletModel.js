import mongoose from "mongoose";

// Enterprise Merchant & Billing Platform (Improvement 3). "Merchant
// Wallet... Credit Balance, Refund Balance, Promotional Credits,
// Adjustment Credits, Reward Credits." Real, per-merchant (never
// per-tenant — the wallet belongs to the commercial identity, same as
// every other entity in this platform). Exactly one per merchant.
//
// A real, deliberate scope boundary: this wallet can OFFSET a future
// real SubscriptionInvoiceModel amount (a human/service applies its
// balance at payment time) but does not itself move real money anywhere
// — crediting it (e.g. from a real refund) or debiting it (e.g. applying
// it to an invoice) are both real, recorded, immutable transactions, but
// there is no real bank/gateway payout FROM this wallet; "cashing out" a
// wallet balance is real, buildable follow-up work, not attempted here.
const WalletTransactionSchema = new mongoose.Schema({
  // Config-driven (walletTransactionTypes) — Credit, Debit.
  transactionType: { type: String, required: true },
  // Config-driven (walletBalanceTypes) — Credit, Refund, Promotional,
  // Adjustment, Reward — which real balance bucket this transaction moved.
  balanceType: { type: String, required: true },
  amount: { type: Number, required: true, min: 0.01 },
  reason: { type: String, default: null },
  // Real reference to whatever real record caused this transaction (an
  // invoice being credited-against, a refund's own source payment, etc.)
  // — Mixed because the referenced collection varies by transactionType,
  // never a fabricated placeholder id.
  referenceId: { type: mongoose.Schema.Types.Mixed, default: null },
  balanceAfter: { type: Number, required: true },
  performedBy: { type: String, default: null },
  performedAt: { type: Date, default: Date.now }
}, { _id: false });

const MerchantWalletSchema = new mongoose.Schema({
  merchantAccountId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "merchant_account",
    required: true,
    unique: true,
    index: true
  },
  currency: { type: String, required: true },
  balances: {
    credit: { type: Number, default: 0 },
    refund: { type: Number, default: 0 },
    promotional: { type: Number, default: 0 },
    adjustment: { type: Number, default: 0 },
    reward: { type: Number, default: 0 }
  },
  transactions: { type: [WalletTransactionSchema], default: [] }
}, {
  timestamps: true,
  optimisticConcurrency: true
});

MerchantWalletSchema.set("toJSON", {
  transform: (_, ret) => {
    delete ret.__v;
    return ret;
  }
});

const MerchantWalletModel = mongoose.model("merchant_wallet", MerchantWalletSchema);

export default MerchantWalletModel;
