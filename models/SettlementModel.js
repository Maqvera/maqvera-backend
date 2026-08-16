import mongoose from "mongoose";

// Enterprise Settlement Engine — Finance Module Part 23. "A payment is
// when money is authorized or captured. A settlement is when the money
// is actually transferred and finalized between financial parties." One
// row per payment being settled. "Settlement history is immutable" —
// corrections/reversals/chargebacks are real, separate
// `SettlementAdjustmentModel` rows, never edits to a completed
// settlement's own gross/fee/net figures. Tenant-scoped only — no
// branchId.
const SettlementFeeSchema = new mongoose.Schema({
  feeType: { type: String, required: true },
  amount: { type: Number, required: true, min: 0 }
}, { _id: false });

const SettlementSplitSchema = new mongoose.Schema({
  splitType: { type: String, required: true },
  // customer | vendor — whichever party this split's share is paid out
  // to, when it has one (Marketplace/PlatformFee splits may have none —
  // they're a retained platform amount, not a payout).
  payeeType: { type: String, default: null },
  payeeId: { type: mongoose.Schema.Types.ObjectId, default: null },
  amount: { type: Number, required: true, min: 0.01 },
  // Populated when a VendorShare/PartnerShare split is actually paid out
  // via the real `VendorCreditService.createCredit` (Part 17's own reuse
  // pattern) — null for a split that's merely recorded (e.g. Marketplace/
  // PlatformFee, retained rather than paid out).
  vendorCreditId: { type: mongoose.Schema.Types.ObjectId, ref: "vendor_credit", default: null }
}, { _id: false });

const SettlementSchema = new mongoose.Schema({
  tenantId: {
    type: String,
    required: true,
    index: true
  },
  settlementNumber: {
    type: String,
    required: true,
    immutable: true
  },
  paymentId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "payment",
    required: true,
    index: true
  },
  settlementAccountId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "bank_account",
    required: true
  },
  // Denormalized from the payment at creation time — Part 7's own
  // `gateway` field (Manual/Stripe/...).
  gateway: { type: String, required: true },
  grossAmount: { type: Number, required: true },
  fees: { type: [SettlementFeeSchema], default: [] },
  feeTotal: { type: Number, default: 0 },
  // The real currency-converted delta when the settlement account's own
  // currency differs from the payment's — via `CurrencyService.convert`
  // (Part 19), never fabricated; 0 when both currencies match.
  fxAdjustment: { type: Number, default: 0 },
  netAmount: { type: Number, required: true },
  currency: { type: String, required: true },
  settlementDate: { type: Date, required: true },
  batchId: { type: mongoose.Schema.Types.ObjectId, ref: "settlement_batch", default: null },
  splits: { type: [SettlementSplitSchema], default: [] },
  // Config-driven (settlementStatuses) — Pending, Sent, Processing,
  // Completed, Failed, Reversed, Disputed, Cancelled. See
  // utils/financeConfig.js's own doc comment for why "Validated"/
  // "Grouped Into Batch" aren't separate resting states here.
  status: {
    type: String,
    required: true,
    index: true
  },
  // "Settlement Reconciliation... Automatic matching." Populated by
  // `SettlementService.reconcileSettlements`, reusing Part 14's own real
  // fuzzy-matching engine against `BankTransactionModel` entries.
  reconciliation: {
    matched: { type: Boolean, default: false },
    matchedBankTransactionId: { type: mongoose.Schema.Types.ObjectId, ref: "bank_transaction", default: null },
    matchScore: { type: Number, default: null },
    matchedAt: { type: Date, default: null }
  },
  journalId: { type: mongoose.Schema.Types.ObjectId, ref: "journal", default: null },
  failureReason: { type: String, default: null },
  timeline: [{
    event: { type: String, required: true },
    description: { type: String, default: null },
    performedBy: { type: String, default: null },
    performedAt: { type: Date, default: Date.now }
  }],
  createdBy: { type: String, default: null },
  updatedBy: { type: String, default: null }
}, { timestamps: true });

SettlementSchema.index({ tenantId: 1, settlementNumber: 1 }, { unique: true });
SettlementSchema.index({ tenantId: 1, paymentId: 1 });
SettlementSchema.index({ tenantId: 1, status: 1 });
SettlementSchema.index({ tenantId: 1, batchId: 1 });
SettlementSchema.index({ tenantId: 1, gateway: 1, settlementDate: 1 });

SettlementSchema.set("toJSON", {
  transform: (_, ret) => {
    delete ret.__v;
    return ret;
  }
});

const SettlementModel = mongoose.model("settlement", SettlementSchema);

export default SettlementModel;
