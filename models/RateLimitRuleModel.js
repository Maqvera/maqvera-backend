import mongoose from "mongoose";

// Enterprise Architecture Hardening Phase — API Rate Limiting & Throttling
// Standard (Improvement 13). "All values configurable." A real,
// admin-configurable override registry — `tenantId: null` is a
// platform-wide default for a (scope, ruleKey) pair; a tenant-specific row
// overrides it. `utils/rateLimiter.js#resolveLimit` checks this registry
// before falling back to `utils/rateLimitConfig.js`'s own static defaults.
const RateLimitRuleSchema = new mongoose.Schema({
  tenantId: { type: String, default: null, index: true },
  // Config-driven (scopes) — Tenant, Merchant, User, ApiKey, IP, Endpoint.
  scope: { type: String, required: true },
  // Optional named rule (e.g. "login", "passwordReset", "search") — null
  // means "this scope's own general default."
  ruleKey: { type: String, default: null },
  limit: { type: Number, required: true, min: 0 },
  windowSeconds: { type: Number, required: true, min: 1 },
  // Config-driven (High/Medium/Low) — the multiplier this rule's own
  // effective limit still gets, on top of `limit` itself.
  priority: { type: String, default: "Medium" },
  owner: { type: String, required: true },
  description: { type: String, default: null },
  // Config-driven (ruleStatuses) — Active, Inactive.
  status: { type: String, required: true, default: "Active" },
  createdBy: { type: String, default: null },
  updatedBy: { type: String, default: null }
}, { timestamps: true, optimisticConcurrency: true });

RateLimitRuleSchema.index({ tenantId: 1, scope: 1, ruleKey: 1 }, { unique: true });

RateLimitRuleSchema.set("toJSON", {
  transform: (_, ret) => {
    delete ret.__v;
    return ret;
  }
});

const RateLimitRuleModel = mongoose.model("rate_limit_rule", RateLimitRuleSchema);

export default RateLimitRuleModel;
