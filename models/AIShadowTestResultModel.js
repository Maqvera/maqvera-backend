import mongoose from "mongoose";

/**
 * EXT-034 §17 "Shadow Testing — Primary model returns response to user.
 * Secondary model executes silently. Outputs compared for evaluation. Used
 * before production rollout." One row per shadow comparison, written by
 * AIModelRouterService._fireShadowTest — fire-and-forget, never on the
 * critical path of the real user-facing response. Excerpts, not full
 * content, are stored (comparison/evaluation doesn't need the entire
 * answer, and this avoids doubling this codebase's already-4000-char
 * tool-result truncation convention into a second full-text store).
 */
const AIShadowTestResultSchema = new mongoose.Schema(
  {
    tenantId: { type: String, required: true, index: true },
    branchId: { type: String, default: "main", index: true },
    category: { type: String, required: true, index: true },
    correlationId: { type: String, default: null, index: true },

    primaryProvider: { type: String, required: true },
    primaryModel: { type: String, default: null },
    primaryContentExcerpt: { type: String, default: null },
    primaryToolCallCount: { type: Number, default: 0 },

    shadowProvider: { type: String, required: true },
    shadowModel: { type: String, default: null },
    shadowContentExcerpt: { type: String, default: null },
    shadowToolCallCount: { type: Number, default: 0 },
    shadowLatencyMs: { type: Number, default: 0 },
    shadowSucceeded: { type: Boolean, default: true },
    shadowErrorMessage: { type: String, default: null },

    // Cheap, real, deterministic comparison signals — never a claim of
    // measuring which answer was actually BETTER (that needs human
    // review, which this codebase has no UI for).
    contentLengthDeltaChars: { type: Number, default: null },
    toolCallDecisionMatched: { type: Boolean, default: null }
  },
  { timestamps: true }
);

AIShadowTestResultSchema.index({ tenantId: 1, category: 1, createdAt: -1 });

export default mongoose.models.AIShadowTestResult || mongoose.model("AIShadowTestResult", AIShadowTestResultSchema);
