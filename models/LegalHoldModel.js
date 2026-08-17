import mongoose from "mongoose";

// Enterprise Architecture Hardening Phase — Data Retention & Legal Hold
// Standard (Improvement 11). A Legal Hold is its own first-class,
// queryable record — not just the boolean flag Improvement 10's
// `applyArchivalPolicy` already put on the target document (that flag is
// still the real, fast, per-record gate `purgeRecord` checks; this
// collection is the real REGISTRY behind it: who applied it, why, when,
// and — since a resource can genuinely be under more than one
// investigation at once — the full history, not just a single reason
// string). "Records Under Legal Hold" (the compliance dashboard
// requirement) reads this collection.
const LegalHoldSchema = new mongoose.Schema({
  tenantId: { type: String, required: true, index: true },
  resourceType: { type: String, required: true, index: true },
  resourceId: { type: String, required: true, index: true },
  reason: { type: String, required: true },
  // Config-driven (legalHoldStatuses) — Active, Removed.
  status: { type: String, required: true, default: "Active", index: true },
  appliedBy: { type: String, required: true },
  appliedAt: { type: Date, default: Date.now },
  removedBy: { type: String, default: null },
  removedAt: { type: Date, default: null },
  removalReason: { type: String, default: null }
}, { timestamps: true });

LegalHoldSchema.index({ tenantId: 1, resourceType: 1, resourceId: 1, status: 1 });

LegalHoldSchema.set("toJSON", {
  transform: (_, ret) => {
    delete ret.__v;
    return ret;
  }
});

const LegalHoldModel = mongoose.model("legal_hold", LegalHoldSchema);

export default LegalHoldModel;
