import mongoose from "mongoose";

// Enterprise Financial Approval Workflow — Finance Module Part 22.
// "Delegation... Temporary Delegate, Permanent Delegate, Out of Office,
// Approval Proxy." A real, dated redirect — when an approver assigned to
// a level has an Active delegation covering the decision date (and
// matching `module`, when the delegation is module-scoped),
// `ApprovalWorkflowService.recordDecision` accepts the decision from the
// delegate on the delegator's behalf, recording both on the decision
// (`decidedOnBehalfOf`). Tenant-scoped only — no branchId.
const ApprovalDelegationSchema = new mongoose.Schema({
  tenantId: {
    type: String,
    required: true,
    index: true
  },
  delegatorUserId: { type: mongoose.Schema.Types.ObjectId, ref: "user", required: true, index: true },
  delegateUserId: { type: mongoose.Schema.Types.ObjectId, ref: "user", required: true },
  // Config-driven (delegationTypes) — Temporary, Permanent, OutOfOffice.
  delegationType: { type: String, required: true },
  // null = every module this delegator could approve for.
  module: { type: String, default: null },
  validFrom: { type: Date, required: true },
  // null = open-ended (required for Permanent; optional for the others).
  validUntil: { type: Date, default: null },
  reason: { type: String, default: null },
  // Active | Ended | Revoked.
  status: { type: String, required: true, default: "Active" },
  createdBy: { type: String, default: null },
  updatedBy: { type: String, default: null }
}, { timestamps: true });

ApprovalDelegationSchema.index({ tenantId: 1, delegatorUserId: 1, status: 1 });

ApprovalDelegationSchema.set("toJSON", {
  transform: (_, ret) => {
    delete ret.__v;
    return ret;
  }
});

const ApprovalDelegationModel = mongoose.model("approval_delegation", ApprovalDelegationSchema);

export default ApprovalDelegationModel;
