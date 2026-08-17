import mongoose from "mongoose";

// Enterprise Architecture Hardening Phase — Data Retention & Legal Hold
// Standard (Improvement 11). "Retention periods MUST be configurable by
// jurisdiction, tenant, and document type." One real, queryable policy
// per (tenantId, resourceType) — `utils/archivalService.js`'s
// `archiveRecord` (Improvement 10) resolves against this registry first,
// falling back to `utils/retentionConfig.js`'s own defaults only when a
// tenant hasn't registered one.
const RetentionPolicySchema = new mongoose.Schema({
  tenantId: { type: String, required: true, index: true },
  resourceType: { type: String, required: true, trim: true },
  // e.g. "FINANCE_10_YEARS" — the spec's own example code, human-readable
  // and stamped onto every archived record this policy applies to.
  policyCode: { type: String, required: true, trim: true },
  retentionYears: { type: Number, required: true, min: 0 },
  jurisdiction: { type: String, default: null },
  description: { type: String, default: null },
  owner: { type: String, required: true, trim: true },
  // Config-driven (policyStatuses) — Active, Inactive.
  status: { type: String, required: true, default: "Active" },
  createdBy: { type: String, default: null },
  updatedBy: { type: String, default: null }
}, { timestamps: true, optimisticConcurrency: true });

RetentionPolicySchema.index({ tenantId: 1, resourceType: 1 }, { unique: true });

RetentionPolicySchema.set("toJSON", {
  transform: (_, ret) => {
    delete ret.__v;
    return ret;
  }
});

const RetentionPolicyModel = mongoose.model("retention_policy", RetentionPolicySchema);

export default RetentionPolicyModel;
