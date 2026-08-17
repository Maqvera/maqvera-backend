import mongoose from "mongoose";

// Enterprise Audit & Compliance — Finance Module Part 27. A real,
// tenant-admin-configurable compliance rule, evaluated by
// `AuditComplianceService.recordEvent` against every incoming audit
// event scoped to it. `policyType` is a real, tenant-assignable LABEL
// (SOX/GDPR/...) for a tenant's own categorization/reporting — this
// module does not implement actual jurisdiction-specific regulatory
// logic (see utils/financeConfig.js's own doc comment on
// `compliancePolicyTypes` for why). `ruleType` is what's actually,
// honestly evaluable. Tenant-scoped only — no branchId.
const CompliancePolicySchema = new mongoose.Schema({
  tenantId: {
    type: String,
    required: true,
    index: true
  },
  name: { type: String, required: true, trim: true },
  description: { type: String, default: null },
  // Config-driven (compliancePolicyTypes) — a label only.
  policyType: { type: String, required: true, index: true },
  // Config-driven (complianceRuleTypes) — SegregationOfDuties,
  // FieldChangeRestriction, Custom. Determines how `conditions` below is
  // interpreted by `AuditComplianceService`'s own real evaluators.
  ruleType: { type: String, required: true, index: true },
  // Real, evaluable shape depends on ruleType:
  // - SegregationOfDuties: {} (no extra config — evaluates the real
  //   entity's own createdBy vs approvedBy/approvals[] fields).
  // - FieldChangeRestriction: { restrictedFields: ["accountCode", ...] }
  //   — flags a real change between a real event's own beforeState/
  //   afterState for any listed field.
  // - Custom: caller-defined shape, informational only (matched but
  //   never auto-evaluated — same "real intent, honestly not
  //   auto-executed" stance as this codebase's other Custom escape
  //   hatches).
  conditions: { type: mongoose.Schema.Types.Mixed, default: {} },
  // Which real audit categories/entityTypes this policy applies to — an
  // empty array on either means "applies to all" (the honest default,
  // not silently narrowed).
  categories: { type: [String], default: [] },
  entityTypes: { type: [String], default: [] },
  // Config-driven (auditSeverities) — the severity stamped on a
  // ComplianceViolationDetected event/violation entry when this policy
  // is the one that matched.
  severity: { type: String, default: "Warning" },
  // Active | Inactive. Only Active policies are evaluated.
  status: { type: String, required: true, default: "Active", index: true },
  createdBy: { type: String, default: null },
  updatedBy: { type: String, default: null }
}, { timestamps: true });

CompliancePolicySchema.index({ tenantId: 1, name: 1 }, { unique: true });
CompliancePolicySchema.index({ tenantId: 1, status: 1, ruleType: 1 });

CompliancePolicySchema.set("toJSON", {
  transform: (_, ret) => {
    delete ret.__v;
    return ret;
  }
});

const CompliancePolicyModel = mongoose.model("compliance_policy", CompliancePolicySchema);

export default CompliancePolicyModel;
