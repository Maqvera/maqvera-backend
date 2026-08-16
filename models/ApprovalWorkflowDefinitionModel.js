import mongoose from "mongoose";

// Enterprise Financial Approval Workflow — Finance Module Part 22. The
// real, versioned, effective-dated workflow definition registry —
// mirrors Part 20/21's own TaxRuleModel/PricingRuleModel design exactly:
// one row per version, immutable after creation, auto-superseded by a
// newer overlapping version for the same `name`. Tenant-scoped only — no
// branchId.
const ApprovalLevelSchema = new mongoose.Schema({
  levelName: { type: String, required: true },
  order: { type: Number, required: true },
  // Role = any user whose CURRENT role's permissions include
  // `approverPermissionKey` (this codebase's real RBAC model —
  // permission-based, never a hardcoded role-name allowlist); User = one
  // specific `approverUserId`.
  approverType: { type: String, required: true, enum: ["Role", "User"] },
  approverPermissionKey: { type: String, default: null },
  approverUserId: { type: mongoose.Schema.Types.ObjectId, ref: "user", default: null },
  // How many DISTINCT approvers at this level must decide 'Approved'
  // before it's satisfied — default null means "all resolved approvers
  // for this level," mirroring Expense's own pre-existing "all assigned
  // must approve" behavior.
  minApprovals: { type: Number, default: null },
  slaHours: { type: Number, default: null }
}, { _id: false });

const ApprovalBranchSchema = new mongoose.Schema({
  // Evaluated in array order on the parent definition — first match
  // wins. Same shape/evaluator as the top-level `conditions` field.
  conditions: { type: mongoose.Schema.Types.Mixed, default: {} },
  approvalType: { type: String, required: true },
  levels: { type: [ApprovalLevelSchema], default: [] }
}, { _id: false });

const ApprovalWorkflowDefinitionSchema = new mongoose.Schema({
  tenantId: {
    type: String,
    required: true,
    index: true
  },
  name: { type: String, required: true },
  description: { type: String, default: null },
  // Config-driven (workflowModules) — Expense, Invoice, Journal,
  // VendorPayment, CustomerCollection, PurchaseOrder, TaxRule,
  // PricingRule, Custom.
  module: { type: String, required: true, index: true },
  // "Approval Rules: Amount, Department, Country, Customer Type, Vendor
  // Type." Real operators evaluated by
  // ApprovalWorkflowService.evaluateConditions — amountGreaterThan(OrEqual),
  // amountLessThan(OrEqual), department, country, customerType,
  // vendorType. "Branch"/"Risk Score"/"Business Unit"/"Project" are
  // dropped/deferred — see utils/financeConfig.js's own doc comment.
  conditions: { type: mongoose.Schema.Types.Mixed, default: {} },
  // Config-driven (approvalTypes) — Sequential, Parallel, AnyOne,
  // AllRequired, MajorityVote, Conditional. When 'Conditional', `levels`
  // below is ignored in favor of the first matching entry in `branches`.
  approvalType: { type: String, required: true },
  levels: { type: [ApprovalLevelSchema], default: [] },
  branches: { type: [ApprovalBranchSchema], default: [] },
  slaHours: { type: Number, default: null },
  escalation: {
    enabled: { type: Boolean, default: false },
    afterHours: { type: Number, default: null },
    escalateToPermissionKey: { type: String, default: null }
  },
  effectiveDate: { type: Date, required: true, index: true },
  endDate: { type: Date, default: null },
  // Config-driven (workflowDefinitionStatuses) — Draft, Approved,
  // Expired, Archived, Superseded.
  status: { type: String, required: true, index: true },
  supersedes: { type: mongoose.Schema.Types.ObjectId, ref: "approval_workflow_definition", default: null },
  timeline: [{
    event: { type: String, required: true },
    description: { type: String, default: null },
    performedBy: { type: String, default: null },
    performedAt: { type: Date, default: Date.now }
  }],
  createdBy: { type: String, default: null },
  updatedBy: { type: String, default: null }
}, { timestamps: true });

ApprovalWorkflowDefinitionSchema.index({ tenantId: 1, name: 1, effectiveDate: -1 });
ApprovalWorkflowDefinitionSchema.index({ tenantId: 1, module: 1, status: 1, effectiveDate: -1 });
ApprovalWorkflowDefinitionSchema.index({ tenantId: 1, status: 1, endDate: 1 });

ApprovalWorkflowDefinitionSchema.set("toJSON", {
  transform: (_, ret) => {
    delete ret.__v;
    return ret;
  }
});

const ApprovalWorkflowDefinitionModel = mongoose.model("approval_workflow_definition", ApprovalWorkflowDefinitionSchema);

export default ApprovalWorkflowDefinitionModel;
