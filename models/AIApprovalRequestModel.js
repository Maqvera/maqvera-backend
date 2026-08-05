import mongoose from "mongoose";

/**
 * "Human Approval Workflow" — mirrors the naming convention already
 * established by utils/WorkflowEngine.js's pendingApprovals entries
 * (requestedBy/requestedByName/requiredRole/status/comments), applied to
 * AI-proposed high-risk actions instead of workflow transitions. Approving
 * a request never executes anything itself — it hands the caller the exact
 * real-endpoint call to make next (see AIOrchestrationService), keeping
 * "Not Responsible For: Database Updates" true even for approved actions.
 */
const AIApprovalRequestSchema = new mongoose.Schema(
  {
    tenantId: { type: String, required: true, index: true },
    branchId: { type: String, default: "main", index: true },
    // Optional: set when the proposal came from a formal AIToolExecution
    // plan (API-006G's /ai/tools/plan → /ai/tools/execute flow); null when
    // it came from a direct conversational turn (API-006F's /ai/chat).
    executionId: { type: mongoose.Schema.Types.ObjectId, ref: "AIToolExecution", default: null, index: true },
    toolName: { type: String, required: true },
    arguments: { type: mongoose.Schema.Types.Mixed, default: {} },
    riskLevel: { type: String, enum: ["medium", "high", "critical"], default: "high" },
    proposedAction: {
      method: { type: String, default: null },
      endpoint: { type: String, default: null },
      body: { type: mongoose.Schema.Types.Mixed, default: null }
    },
    requestedBy: { type: String, required: true },
    requestedByName: { type: String, default: "User" },
    requiredRole: { type: String, default: "admin" },
    status: { type: String, enum: ["pending", "approved", "rejected"], default: "pending", index: true },
    decidedBy: { type: String, default: null },
    decidedByName: { type: String, default: null },
    decisionReason: { type: String, default: null },
    decidedAt: { type: Date, default: null }
  },
  { timestamps: true }
);

AIApprovalRequestSchema.index({ tenantId: 1, status: 1, createdAt: -1 });

export default mongoose.models.AIApprovalRequest || mongoose.model("AIApprovalRequest", AIApprovalRequestSchema);
