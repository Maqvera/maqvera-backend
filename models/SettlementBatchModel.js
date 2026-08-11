import mongoose from "mongoose";

// Enterprise Settlement Engine — Finance Module Part 23. Mirrors Part
// 17's own `PaymentBatchModel` design closely — a real grouping of
// individual settlements sent to the bank together, with a real
// generated payment file (reuses `services/paymentFileGenerators/`
// directly, the same real CSV/ACH/SEPA/SWIFT generation Part 17 already
// built, not a parallel implementation). Tenant-scoped only — no
// branchId.
const SettlementBatchSchema = new mongoose.Schema({
  tenantId: {
    type: String,
    required: true,
    index: true
  },
  batchNumber: {
    type: String,
    required: true,
    immutable: true
  },
  // Config-driven (settlementBatchTypes) — Daily, Weekly, Monthly,
  // Gateway, Merchant, Manual.
  batchType: { type: String, required: true },
  settlementAccountId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "bank_account",
    required: true
  },
  currency: { type: String, required: true },
  settlementIds: { type: [mongoose.Schema.Types.ObjectId], default: [] },
  totalGrossAmount: { type: Number, default: 0 },
  totalFees: { type: Number, default: 0 },
  totalNetAmount: { type: Number, default: 0 },
  // Open | Sent | Processing | Completed | PartiallyFailed.
  status: { type: String, required: true, default: "Open" },
  fileGeneration: {
    format: { type: String, default: null },
    generatedAt: { type: Date, default: null },
    url: { type: String, default: null },
    storageKey: { type: String, default: null },
    storageProvider: { type: String, default: null }
  },
  scheduledDate: { type: Date, default: null },
  sentAt: { type: Date, default: null },
  completedAt: { type: Date, default: null },
  timeline: [{
    event: { type: String, required: true },
    description: { type: String, default: null },
    performedBy: { type: String, default: null },
    performedAt: { type: Date, default: Date.now }
  }],
  createdBy: { type: String, default: null },
  updatedBy: { type: String, default: null }
}, { timestamps: true });

SettlementBatchSchema.index({ tenantId: 1, batchNumber: 1 }, { unique: true });
SettlementBatchSchema.index({ tenantId: 1, status: 1 });

SettlementBatchSchema.set("toJSON", {
  transform: (_, ret) => {
    delete ret.__v;
    return ret;
  }
});

const SettlementBatchModel = mongoose.model("settlement_batch", SettlementBatchSchema);

export default SettlementBatchModel;
