import mongoose from "mongoose";

/**
 * EXT-031 §11/§12/§20 "Prompt Versioning" / "Prompt Lifecycle" /
 * "Monitoring". A version is created once and never edited after creation
 * — §19 "Prompt history immutable" — only its `status` and usage counters
 * change; `content` is fixed at creation time. A new edit is always a NEW
 * version (see AIPromptService.createVersion).
 */
const AIPromptVersionSchema = new mongoose.Schema(
  {
    promptId: { type: mongoose.Schema.Types.ObjectId, ref: "AIPrompt", required: true, index: true },
    tenantId: { type: String, required: true, index: true },
    version: { type: Number, required: true },
    // The raw template text with {{variable}} placeholders (§10) —
    // resolved dynamically at use time, never baked into source code.
    content: { type: String, required: true },
    language: { type: String, default: "en" },
    description: { type: String, default: null },
    status: {
      type: String,
      enum: ["draft", "review", "testing", "approved", "published", "archived", "rejected"],
      default: "draft",
      index: true
    },
    author: { type: String, required: true },
    publishedBy: { type: String, default: null },
    publishedAt: { type: Date, default: null },
    // Set when this version is superseded by a later publish or an
    // explicit archive — never cleared, so "when did this stop being
    // live" stays answerable from the row itself.
    archivedAt: { type: Date, default: null },
    // §15 "Rollback ... Instant Rollback ... Audit Logged." True only for
    // a version that became published THROUGH a rollback action (not its
    // original publish) — lets monitoring/audit distinguish "promoted
    // forward" from "reverted to" without parsing the audit log text.
    isRollback: { type: Boolean, default: false },
    // §20 "Monitoring — Execution Count, Average Latency, Prompt Size,
    // Token Usage, Success Rate." Real counters, incremented by
    // AIPromptService.recordUsage() every time this exact version is
    // actually used for a live LLM call — never a fabricated/estimated
    // figure. Average latency/tokens are derived (total / count) rather
    // than stored directly, so they're always consistent with the raw sums.
    usage: {
      executionCount: { type: Number, default: 0 },
      successCount: { type: Number, default: 0 },
      failureCount: { type: Number, default: 0 },
      totalLatencyMs: { type: Number, default: 0 },
      totalTokens: { type: Number, default: 0 }
    },
    // §13 "Prompt Testing ... Golden Dataset ... Quality Scores." Each
    // entry is one full run of this version against the prompt's test
    // cases (AIPromptTestCaseModel) at that point in time — kept as a
    // history, not just the latest result, so a quality trend is real and
    // inspectable rather than a single overwritten number.
    testRuns: [
      {
        ranAt: { type: Date, default: Date.now },
        ranBy: { type: String, required: true },
        results: [
          {
            testCaseId: { type: mongoose.Schema.Types.ObjectId, ref: "AIPromptTestCase" },
            passed: { type: Boolean, required: true },
            actualOutputExcerpt: { type: String, default: null },
            missingContains: [{ type: String }],
            unexpectedContains: [{ type: String }],
            error: { type: String, default: null }
          }
        ],
        passRate: { type: Number, default: 0 }
      }
    ]
  },
  { timestamps: true }
);

AIPromptVersionSchema.index({ promptId: 1, version: 1 }, { unique: true });
AIPromptVersionSchema.index({ tenantId: 1, status: 1 });

export default mongoose.models.AIPromptVersion || mongoose.model("AIPromptVersion", AIPromptVersionSchema);
