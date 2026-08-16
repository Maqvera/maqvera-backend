import mongoose from "mongoose";

// Enterprise Customer Payments — Finance Module Part 18 Part 4 (Enterprise
// Collection Features). "Wallet Support... Customer Wallet, Merchant
// Wallet, Marketplace Wallet, Partner Wallet, Employee Wallet, Prepaid
// Wallet, Gift Wallet." Only Customer is a real, FK-validated owner in
// this codebase (`customerId`) — Merchant/Marketplace/Partner have no
// owning module to validate against (same informational treatment as
// `merchantId` on PaymentIntentModel/CustomerCollectionModel since Part
// 2), and Employee/Prepaid/Gift are real distinctions of a Customer
// wallet's *purpose*, not a different owner entity — captured by
// `walletType` alone rather than fabricating separate owner models.
// `balance` is a cached running total, always updated in the same
// operation as the transaction that changes it (`WalletTransactionModel`
// is the append-only source of truth) — same discipline as
// `CustomerCollectionModel.collectedAmount`. Tenant-scoped only — no
// branchId.
const WalletSchema = new mongoose.Schema({
  tenantId: {
    type: String,
    required: true,
    index: true
  },
  walletNumber: {
    type: String,
    required: true,
    immutable: true
  },
  customerId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "customer",
    required: true,
    index: true
  },
  // Denormalized snapshot — same convention as every other Finance model
  // that references Customer.
  customerName: {
    type: String,
    required: true
  },
  // Config-driven (utils/financeConfig.js walletTypes) — Customer,
  // Merchant, Marketplace, Partner, Employee, Prepaid, Gift.
  walletType: {
    type: String,
    required: true,
    index: true
  },
  currency: {
    type: String,
    required: true
  },
  balance: {
    type: Number,
    required: true,
    default: 0
  },
  // Config-driven (walletStatuses) — Active, Suspended, Closed.
  status: {
    type: String,
    required: true,
    index: true
  },
  // Optional cap — 0/null means unlimited. Real, enforced on top-up.
  maxBalance: { type: Number, default: null },
  suspendedReason: { type: String, default: null },
  closedAt: { type: Date, default: null },
  timeline: [{
    event: { type: String, required: true },
    description: { type: String, default: null },
    performedBy: { type: String, default: null },
    performedAt: { type: Date, default: Date.now }
  }],
  createdBy: { type: String, default: null },
  updatedBy: { type: String, default: null }
}, { timestamps: true });

WalletSchema.index({ tenantId: 1, walletNumber: 1 }, { unique: true });
// One real wallet per customer/currency/type — "top up the wallet" always
// resolves unambiguously rather than needing the caller to pick among
// several identical wallets.
WalletSchema.index({ tenantId: 1, customerId: 1, walletType: 1, currency: 1 }, { unique: true });

WalletSchema.set("toJSON", {
  transform: (_, ret) => {
    delete ret.__v;
    return ret;
  }
});

const WalletModel = mongoose.model("wallet", WalletSchema);

export default WalletModel;
