import mongoose from "mongoose";

// Enterprise Settlement Engine — Finance Module Part 23. "Settlement
// Adjustments... Corrections, Reversals, Chargebacks, Manual
// Adjustments, Compensation Entries. Auditable." A real, append-only
// adjustment log against an existing Settlement — "Settlement history is
// immutable," so a correction is always a NEW row here, never an edit to
// the original SettlementModel's own gross/fee/net figures. `Chargeback`
// never duplicates Part 12's own real, complete `ChargebackModel`
// workflow — it only LINKS an existing chargeback (`chargebackId`).
// Tenant-scoped only — no branchId.
const SettlementAdjustmentSchema = new mongoose.Schema({
  tenantId: {
    type: String,
    required: true,
    index: true
  },
  settlementId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "settlement",
    required: true,
    index: true
  },
  // Config-driven (settlementAdjustmentTypes) — Correction, Reversal,
  // ManualAdjustment, CompensationEntry, Chargeback.
  adjustmentType: { type: String, required: true },
  // Positive = increases the settlement's own net (a compensation/
  // correction in the tenant's favor); negative = decreases it (a
  // reversal, a chargeback debit).
  amount: { type: Number, required: true },
  reason: { type: String, default: null },
  // Only set when adjustmentType === 'Chargeback' — the real, existing
  // Part 12 ChargebackModel row this adjustment reflects, never a
  // reimplemented dispute record.
  chargebackId: { type: mongoose.Schema.Types.ObjectId, ref: "chargeback", default: null },
  journalId: { type: mongoose.Schema.Types.ObjectId, ref: "journal", default: null },
  performedBy: { type: String, default: null },
  createdAt: { type: Date, default: Date.now }
}, { timestamps: true });

SettlementAdjustmentSchema.index({ tenantId: 1, settlementId: 1, createdAt: -1 });

SettlementAdjustmentSchema.set("toJSON", {
  transform: (_, ret) => {
    delete ret.__v;
    return ret;
  }
});

const SettlementAdjustmentModel = mongoose.model("settlement_adjustment", SettlementAdjustmentSchema);

export default SettlementAdjustmentModel;
