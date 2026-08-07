import mongoose from "mongoose";

/**
 * EXT-034 §9 "Routing Rules" / §14 "Cost Optimization" / AI Coding Rules
 * "Configurable Routing Rules — No Hardcoded Providers." Tenant-configurable
 * override of AIModelRouterService's default provider order for one model
 * category. Mirrors the exact same shape/intent as EXT-032's AIPolicyModel
 * (a real, DB-backed, admin-managed override layer sitting on top of a
 * static, real code-driven default) — no policy row is required for
 * routing to work; the router's own `defaultRoutingOrder`
 * (utils/aiModelConfig.js) already provides sane, real behavior with zero
 * configuration.
 */
const AIRoutingPolicySchema = new mongoose.Schema(
  {
    tenantId: { type: String, required: true, index: true },
    branchId: { type: String, default: "main", index: true },
    category: {
      type: String,
      enum: ["reasoning", "general_chat", "fast", "low_cost", "vision", "embedding", "speech", "code", "planning"],
      required: true
    },
    // Ordered provider-name list, e.g. ["Anthropic", "OpenAI"]. Overrides
    // the router's default priority order for this tenant+category, but
    // never REPLACES real capability filtering (an ineligible provider
    // listed here is still skipped) — this only re-orders/restricts among
    // otherwise-eligible candidates.
    preferredProviders: [{ type: String }],
    // §14 "Cheapest suitable model selected when allowed." When true, the
    // router sorts eligible candidates by real, configured cost-per-1K
    // ascending instead of the catalog's static priority order.
    costOptimized: { type: Boolean, default: false },
    // §16/§17 — written automatically by AIModelRouterService.promoteABTestWinner
    // once a human approves a winner; pins routing to that exact
    // (provider, model) pair rather than just the provider's own default
    // model.
    preferredModelOverride: {
      provider: { type: String, default: null },
      model: { type: String, default: null }
    },
    // §17 "Shadow Testing." When set, every request routed for this
    // tenant+category also fires a silent, non-blocking call to this
    // provider/model, logged for comparison (AIShadowTestResultModel) —
    // never shown to the user, never affects the real response.
    shadowProvider: { type: String, default: null },
    shadowModel: { type: String, default: null },
    isActive: { type: Boolean, default: true, index: true },
    createdBy: { type: String, required: true },
    updatedBy: { type: String, default: null }
  },
  { timestamps: true }
);

// One active policy per tenant+branch+category — the router looks up
// exactly one row; a second active row for the same key would be
// ambiguous, not a real "combine both" scenario.
AIRoutingPolicySchema.index({ tenantId: 1, branchId: 1, category: 1 }, { unique: true });

export default mongoose.models.AIRoutingPolicy || mongoose.model("AIRoutingPolicy", AIRoutingPolicySchema);
