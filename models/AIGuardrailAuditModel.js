import mongoose from "mongoose";

/**
 * EXT-032 §20 "Audit — Policy ID, Decision, Risk Score, Approver, Tool
 * Called, Reason, Timestamp, Correlation ID. Immutable history." A row is
 * only ever created, never updated — same immutability discipline as
 * AuditLogModel elsewhere in this codebase — recorded by
 * AIGuardrailService.evaluate() for every non-read tool call (reads never
 * reach the Policy Engine at all, see AIToolRegistry.execute's own scoping
 * note, so they generate no audit noise here).
 */
const AIGuardrailAuditSchema = new mongoose.Schema(
  {
    tenantId: { type: String, required: true, index: true },
    branchId: { type: String, default: "main", index: true },
    userId: { type: String, default: null, index: true },
    correlationId: { type: String, default: null, index: true },
    toolName: { type: String, default: null, index: true },
    decision: { type: String, enum: ["allowed", "blocked"], required: true, index: true },
    riskLevel: { type: String, enum: ["low", "medium", "high", "critical"], required: true, index: true },
    riskScore: { type: Number, required: true },
    riskReasons: [{ type: String }],
    policyId: { type: mongoose.Schema.Types.ObjectId, ref: "AIPolicy", default: null },
    reason: { type: String, default: null },
    promptInjectionFlagged: { type: Boolean, default: false, index: true },
    sensitiveFieldsDetected: [{ type: String }]
  },
  { timestamps: true }
);

AIGuardrailAuditSchema.index({ tenantId: 1, createdAt: -1 });
AIGuardrailAuditSchema.index({ tenantId: 1, decision: 1, createdAt: -1 });

export default mongoose.models.AIGuardrailAudit || mongoose.model("AIGuardrailAudit", AIGuardrailAuditSchema);
