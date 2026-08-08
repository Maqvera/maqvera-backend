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
    // Optional: set when the proposal came from a formal AIToolExecution
    // plan (API-006G's /ai/tools/plan → /ai/tools/execute flow); null when
    // it came from a direct conversational turn (API-006F's /ai/chat).
    executionId: { type: mongoose.Schema.Types.ObjectId, ref: "AIToolExecution", default: null, index: true },
    // EXT-036 §23 "Idempotency ... Duplicate executions ignored safely."
    // Deterministic per plan step (see AIOrchestrationService.createPlan);
    // null for a propose_* call made outside a formal plan (a direct
    // conversational turn via AIAssistantService.chat has no stepNumber to
    // key off of). The unique index below is the real, atomic guard — a
    // concurrent duplicate call cannot create two pending requests for the
    // same step, it will hit this index and the handler falls back to
    // returning the existing request instead.
    idempotencyKey: { type: String, default: null },
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
    decidedAt: { type: Date, default: null },
    // EXT-036 §14 "Compensation". Per explicit product decision, a hotel
    // step failing elsewhere in the same plan NEVER auto-cancels a
    // successful flight proposal (there is no real reservation to roll back
    // at this layer anyway — see the module docblock) — it only flags this
    // request so the human approver sees the partial failure before
    // deciding. Left null/flagged:false on every request unaffected by a
    // sibling step's failure.
    compensationFlag: {
      flagged: { type: Boolean, default: false },
      reason: { type: String, default: null },
      relatedIncidentId: { type: mongoose.Schema.Types.ObjectId, ref: "travel_incident_management", default: null },
      flaggedAt: { type: Date, default: null }
    },
    // EXT-029 §15 "Timeout Handling — Approval Timeout -> Reminder ->
    // Escalation -> Auto Cancel (Configurable)." Product decision for this
    // build: reminder/escalation notifications only, never an auto-reject
    // — so there is no expiry/auto-cancel field here, only these two
    // timestamps, which exist purely so the sweep (aiApprovalTimeoutScheduler.js)
    // sends each notification at most once per request rather than
    // re-firing it every sweep interval.
    reminderSentAt: { type: Date, default: null },
    escalatedAt: { type: Date, default: null }
  },
  { timestamps: true }
);

AIApprovalRequestSchema.index({ tenantId: 1, status: 1, createdAt: -1 });
// Partial (not merely sparse) — Mongoose's `default: null` above makes the
// field genuinely *present* with value null on every document that omits
// it, so a plain sparse index would still enforce uniqueness across all of
// those nulls. Scoping to only real string keys is what actually limits
// this constraint to genuine idempotency-key collisions.
AIApprovalRequestSchema.index(
  { tenantId: 1, idempotencyKey: 1 },
  { unique: true, partialFilterExpression: { idempotencyKey: { $type: "string" } } }
);

export default mongoose.models.AIApprovalRequest || mongoose.model("AIApprovalRequest", AIApprovalRequestSchema);
