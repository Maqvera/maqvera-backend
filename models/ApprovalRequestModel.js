import mongoose from "mongoose";

// Enterprise Financial Approval Workflow — Finance Module Part 22. One
// live approval instance for one real business entity. "Immutable
// Workflow History" — `levels` is a snapshot of the resolved workflow
// (including concrete resolved approver userIds) taken at `startApproval`
// time; a later change to the workflow DEFINITION never retroactively
// changes an in-flight or completed request. Tenant-scoped only — no
// branchId.
const ResolvedLevelSchema = new mongoose.Schema({
  levelName: { type: String, required: true },
  order: { type: Number, required: true },
  approverUserIds: { type: [mongoose.Schema.Types.ObjectId], default: [] },
  minApprovals: { type: Number, required: true },
  slaHours: { type: Number, default: null },
  slaDeadline: { type: Date, default: null }
}, { _id: false });

const ApprovalDecisionSchema = new mongoose.Schema({
  levelIndex: { type: Number, required: true },
  approverId: { type: mongoose.Schema.Types.ObjectId, ref: "user", required: true },
  // Real userId whose decision this actually was, when recorded via an
  // active delegation on the approver's own behalf — null when the
  // approver decided directly.
  decidedOnBehalfOf: { type: mongoose.Schema.Types.ObjectId, ref: "user", default: null },
  decision: { type: String, required: true, enum: ["Approved", "Rejected"] },
  comments: { type: String, default: null },
  // "Digital Signature... Electronic Signature, Approval Hash, Timestamp,
  // Non-Repudiation." A real SHA-256 hash over
  // (requestId + levelIndex + approverId + decision + timestamp) —
  // independently reproducible/verifiable given the same inputs.
  // "Certificate Validation" (real PKI/X.509) is honestly not
  // implemented — no certificate infrastructure exists in this codebase.
  signatureHash: { type: String, required: true },
  decidedAt: { type: Date, default: Date.now }
}, { _id: false });

const ApprovalRequestSchema = new mongoose.Schema({
  tenantId: {
    type: String,
    required: true,
    index: true
  },
  // Config-driven (workflowModules).
  module: { type: String, required: true, index: true },
  entityId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
  entityRef: { type: String, default: null },
  workflowDefinitionId: { type: mongoose.Schema.Types.ObjectId, ref: "approval_workflow_definition", required: true },
  workflowDefinitionName: { type: String, required: true },
  // Resolved from the definition's own `approvalType`/`branches` at
  // start time — see ApprovalWorkflowDefinitionModel's own doc comment.
  approvalType: { type: String, required: true },
  levels: { type: [ResolvedLevelSchema], required: true },
  decisions: { type: [ApprovalDecisionSchema], default: [] },
  currentLevelIndex: { type: Number, default: 0 },
  // Config-driven (approvalRequestStatuses) — Pending, Escalated,
  // Approved, Rejected, Cancelled, Expired.
  status: { type: String, required: true, index: true },
  // The real amount/department/country/etc used to resolve this
  // workflow's conditions — kept for audit/reproducibility, mirroring
  // Part 20/21's own "Calculation Trace"/"historical rules can be
  // reproduced" discipline.
  context: { type: mongoose.Schema.Types.Mixed, default: {} },
  escalatedAt: { type: Date, default: null },
  escalatedTo: { type: mongoose.Schema.Types.ObjectId, ref: "user", default: null },
  cancelledBy: { type: String, default: null },
  cancelledAt: { type: Date, default: null },
  cancellationReason: { type: String, default: null },
  requestedBy: { type: String, default: null },
  requestedAt: { type: Date, default: Date.now },
  completedAt: { type: Date, default: null },
  timeline: [{
    event: { type: String, required: true },
    description: { type: String, default: null },
    performedBy: { type: String, default: null },
    performedAt: { type: Date, default: Date.now }
  }]
}, { timestamps: true });

ApprovalRequestSchema.index({ tenantId: 1, module: 1, entityId: 1 });
ApprovalRequestSchema.index({ tenantId: 1, status: 1 });
ApprovalRequestSchema.index({ tenantId: 1, status: 1, "levels.slaDeadline": 1 });

ApprovalRequestSchema.set("toJSON", {
  transform: (_, ret) => {
    delete ret.__v;
    return ret;
  }
});

const ApprovalRequestModel = mongoose.model("approval_request", ApprovalRequestSchema);

export default ApprovalRequestModel;
