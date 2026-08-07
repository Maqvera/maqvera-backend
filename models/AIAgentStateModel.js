import mongoose from "mongoose";

/**
 * EXT-035 §21 "Agent Lifecycle — Draft -> Testing -> Approved -> Active ->
 * Deprecated -> Archived." A real, DB-backed, tenant-configurable OVERLAY on
 * top of `services/ai/AIAgentRegistry.js`'s static, in-code agent
 * definitions — mirrors exactly how EXT-032's `AIPolicyModel` overlays the
 * static, real `AIToolRegistry` rather than replacing it. The registry
 * still owns what an agent's real capabilities/tools ARE (you can't
 * "activate" an agent whose tools don't exist); this overlay only controls
 * whether the Supervisor is currently allowed to select it, and its
 * tenant-visible priority.
 *
 * An agent with no row here is honestly treated as "active" at its
 * registry-declared default priority — this is what keeps every agent
 * shipped before this document behaviorally unchanged until an admin
 * deliberately transitions one.
 */
const AIAgentStateSchema = new mongoose.Schema(
  {
    tenantId: { type: String, required: true, index: true },
    agentId: { type: String, required: true, index: true },
    status: { type: String, enum: ["draft", "testing", "approved", "active", "deprecated", "archived"], default: "active" },
    priority: { type: Number, default: null },
    // Free-text operator note on WHY a status changed (e.g. "failing too
    // often in testing, reverting to draft") — not surfaced to end users.
    statusReason: { type: String, default: null },
    updatedBy: { type: String, required: true }
  },
  { timestamps: true }
);

AIAgentStateSchema.index({ tenantId: 1, agentId: 1 }, { unique: true });

export default mongoose.models.AIAgentState || mongoose.model("AIAgentState", AIAgentStateSchema);
