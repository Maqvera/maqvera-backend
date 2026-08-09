import mongoose from "mongoose";

/**
 * EXT-032 §5 "Policy Categories ... Policies configurable." Tenant-defined,
 * DB-backed policy rows the Policy Engine (services/ai/AIGuardrailService.js)
 * evaluates on every non-read tool call. Deliberately only three rule types
 * are supported — each one is genuinely, immediately enforceable against the
 * real tool catalog today. A "require_approval" type is NOT included: every
 * non-read tool in AIToolRegistry already requires approval, so a policy
 * type promising to dynamically wrap an arbitrary tool in an approval flow
 * it doesn't support would be a half-built feature that looks configurable
 * but does nothing new.
 */
const AIPolicySchema = new mongoose.Schema(
  {
    tenantId: { type: String, required: true, index: true },
    category: { type: String, enum: ["Security", "Business", "Travel", "Finance", "Privacy", "Compliance", "AI", "Custom"], required: true, index: true },
    name: { type: String, required: true },
    description: { type: String, default: null },
    ruleType: { type: String, enum: ["block_tool", "restrict_role", "max_risk_level"], required: true },
    // block_tool / restrict_role: null toolName means "applies to every
    // non-read tool" (a tenant-wide guard); a specific tool name scopes it.
    // max_risk_level: toolName is likewise optional — null applies the
    // threshold across every non-read tool call.
    toolName: { type: String, default: null, index: true },
    // restrict_role only.
    allowedRoles: [{ type: String }],
    // max_risk_level only — blocks when the request's REAL, computed risk
    // level (AIGuardrailService.assessRisk) meets or exceeds this.
    riskLevelThreshold: { type: String, enum: ["low", "medium", "high", "critical"], default: null },
    isActive: { type: Boolean, default: true, index: true },
    createdBy: { type: String, required: true },
    updatedBy: { type: String, default: null }
  },
  { timestamps: true }
);

AIPolicySchema.index({ tenantId: 1, isActive: 1, ruleType: 1 });

export default mongoose.models.AIPolicy || mongoose.model("AIPolicy", AIPolicySchema);
