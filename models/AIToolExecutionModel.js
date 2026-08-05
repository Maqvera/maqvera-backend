import mongoose from "mongoose";

/**
 * "Execution Log" — Execution ID, Prompt, Plan, Tools Used, Execution Time,
 * Provider, Cost, Token Usage, Status, Errors, Audit Reference. A plan is
 * created (status "planned") before any tool runs, then transitions to
 * "executing" → "completed"/"failed"/"awaiting_approval"/"rejected".
 */
const AIToolExecutionSchema = new mongoose.Schema(
  {
    tenantId: { type: String, required: true, index: true },
    branchId: { type: String, default: "main", index: true },
    userId: { type: String, required: true, index: true },
    conversationId: { type: mongoose.Schema.Types.ObjectId, ref: "AIConversation", default: null },
    prompt: { type: String, required: true },
    correlationId: { type: String, required: true, index: true },
    plan: [
      {
        stepNumber: { type: Number, required: true },
        toolName: { type: String, required: true },
        arguments: { type: mongoose.Schema.Types.Mixed, default: {} },
        parallelGroup: { type: Number, default: null },
        requiresApproval: { type: Boolean, default: false },
        reasoning: { type: String, default: null }
      }
    ],
    status: {
      type: String,
      enum: ["planned", "executing", "completed", "failed", "awaiting_approval", "rejected"],
      default: "planned",
      index: true
    },
    toolExecutions: [
      {
        stepNumber: { type: Number },
        toolName: { type: String, required: true },
        arguments: { type: mongoose.Schema.Types.Mixed, default: {} },
        succeeded: { type: Boolean, default: false },
        retryCount: { type: Number, default: 0 },
        durationMs: { type: Number, default: 0 },
        startedAt: { type: Date, default: Date.now },
        error: { type: String, default: null }
      }
    ],
    provider: { type: String, default: null },
    finalAnswer: { type: String, default: null },
    tokenUsage: {
      inputTokens: { type: Number, default: 0 },
      outputTokens: { type: Number, default: 0 },
      totalTokens: { type: Number, default: 0 }
    },
    // Real per-token math against configured rates, always labeled as an
    // estimate — actual provider billing can differ.
    estimatedCostUsd: { type: Number, default: 0 },
    totalExecutionTimeMs: { type: Number, default: 0 },
    // Named `executionErrors`, not `errors` — Mongoose reserves `errors` as
    // a Document-internal validation-error pathname; reusing it produces a
    // runtime warning and risks colliding with Mongoose's own machinery.
    executionErrors: [{ type: String }],
    auditReference: { type: String, default: null }
  },
  { timestamps: true }
);

AIToolExecutionSchema.index({ tenantId: 1, userId: 1, createdAt: -1 });
AIToolExecutionSchema.index({ tenantId: 1, status: 1 });

export default mongoose.models.AIToolExecution || mongoose.model("AIToolExecution", AIToolExecutionSchema);
