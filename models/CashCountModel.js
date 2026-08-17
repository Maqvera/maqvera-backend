import mongoose from "mongoose";

// Cash Counts — Finance Module Part 15. "Opening Balance -> Transactions
// -> Cash Count -> Expected Balance -> Actual Balance -> Variance Report."
// The real source of Shortage/Overage detection — a location isn't
// permanently "in shortage," a specific count reveals one (see
// utils/financeConfig.js cashLocationStatuses doc comment).
const CashCountSchema = new mongoose.Schema({
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
  countNumber: {
    type: String,
    required: true,
    immutable: true
  },
  // Config-driven (cashCountTypes) — Scheduled, Surprise, Daily Closing,
  // Weekly, Monthly, Manual.
  countType: { type: String, required: true },
  // The location's real ledger balance (sum of CashTransactionModel) at
  // the moment this count was taken — not caller-supplied, computed.
  expectedBalance: { type: Number, required: true },
  // The physically counted amount — caller-supplied, the whole point of a
  // count.
  actualBalance: { type: Number, required: true },
  currency: { type: String, required: true },
  variance: { type: Number, required: true },
  // None | Shortage | Overage — None when |variance| is at/under the
  // configured cashCountVarianceTolerance.
  varianceType: { type: String, enum: ["None", "Shortage", "Overage"], required: true },
  // Balanced (varianceType "None", nothing further to do) | Variance
  // Pending (a real discrepancy exists, awaiting resolution) | Resolved
  // (a correcting adjustment was posted).
  status: { type: String, enum: ["Balanced", "Variance Pending", "Resolved"], required: true, index: true },
  notes: { type: String, default: null },
  countedBy: { type: String, default: null },
  countedAt: { type: Date, default: Date.now },
  // Set once resolveCashCountVariance posts the real correcting
  // CashTransactionModel/journal entry that brings the ledger in line with
  // the physically-counted actual balance.
  adjustmentTransactionId: { type: mongoose.Schema.Types.ObjectId, ref: "cash_transaction", default: null },
  resolvedBy: { type: String, default: null },
  resolvedAt: { type: Date, default: null },
  resolutionNotes: { type: String, default: null },
  timeline: [{
    event: { type: String, required: true },
    description: { type: String, default: null },
    performedBy: { type: String, default: null },
    performedAt: { type: Date, default: Date.now }
  }],
  createdBy: { type: String, default: null }
}, { timestamps: true });

CashCountSchema.index({ tenantId: 1, countNumber: 1 }, { unique: true });
CashCountSchema.index({ tenantId: 1, cashLocationId: 1, createdAt: -1 });
CashCountSchema.index({ tenantId: 1, status: 1 });

CashCountSchema.set("toJSON", {
  transform: (_, ret) => {
    delete ret.__v;
    return ret;
  }
});

const CashCountModel = mongoose.model("cash_count", CashCountSchema);

export default CashCountModel;
