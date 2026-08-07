import mongoose from "mongoose";

/**
 * EXT-034 §16 "A/B Testing — Model A vs Model B, Compare Quality/Latency/
 * Cost/User Satisfaction. Winner promoted automatically after approval."
 * The comparison itself is real: every request routed while a test is
 * `running` is tagged with `abTestId`/`abVariant` on its own
 * AIRequestMetricModel row (EXT-033's real per-request fact table), so
 * `AIModelRouterService.getABTestResults()` aggregates genuine, measured
 * latency/cost/success-rate per variant — never a simulated comparison.
 * "User Satisfaction" is deliberately not a tracked field here — this
 * codebase has no rating/feedback capability anywhere to derive it from
 * real data (same honest gap already noted in EXT-033's quality metrics).
 */
const AIABTestSchema = new mongoose.Schema(
  {
    tenantId: { type: String, required: true, index: true },
    branchId: { type: String, default: "main", index: true },
    category: {
      type: String,
      enum: ["reasoning", "general_chat", "fast", "low_cost", "vision", "embedding", "speech", "code", "planning"],
      required: true,
      index: true
    },
    name: { type: String, required: true },
    description: { type: String, default: null },
    variantA: {
      provider: { type: String, required: true },
      model: { type: String, default: null }
    },
    variantB: {
      provider: { type: String, required: true },
      model: { type: String, default: null }
    },
    // % of routed traffic assigned to Variant A; the remainder goes to B.
    trafficSplitPct: { type: Number, default: 50, min: 1, max: 99 },
    status: { type: String, enum: ["draft", "running", "completed", "cancelled"], default: "draft", index: true },
    winner: { type: String, enum: ["A", "B", null], default: null },
    startedAt: { type: Date, default: null },
    endedAt: { type: Date, default: null },
    createdBy: { type: String, required: true },
    promotedBy: { type: String, default: null },
    promotedAt: { type: Date, default: null }
  },
  { timestamps: true }
);

AIABTestSchema.index({ tenantId: 1, category: 1, status: 1 });

export default mongoose.models.AIABTest || mongoose.model("AIABTest", AIABTestSchema);
