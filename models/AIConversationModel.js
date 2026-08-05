import mongoose from "mongoose";

const AIConversationSchema = new mongoose.Schema(
  {
    tenantId: { type: String, required: true, index: true },
    branchId: { type: String, default: "main", index: true },
    userId: { type: String, required: true, index: true },
    mode: {
      type: String,
      enum: ["Assistant", "Operations", "Management", "Customer", "Finance", "Support", "Developer"],
      default: "Assistant"
    },
    status: { type: String, enum: ["active", "archived"], default: "active", index: true },
    messages: [
      {
        role: { type: String, enum: ["user", "assistant", "tool"], required: true },
        content: { type: String, default: "" },
        toolName: { type: String, default: null },
        toolArguments: { type: mongoose.Schema.Types.Mixed, default: null },
        createdAt: { type: Date, default: Date.now }
      }
    ],
    toolExecutions: [
      {
        toolName: { type: String, required: true },
        arguments: { type: mongoose.Schema.Types.Mixed, default: {} },
        succeeded: { type: Boolean, default: true },
        durationMs: { type: Number, default: 0 },
        executedAt: { type: Date, default: Date.now }
      }
    ],
    provider: { type: String, default: null },
    // "Confidence Score", "Source Attribution" — real, derived signals
    // (not fabricated certainty): confidence reflects whether the answer
    // was grounded in at least one successful tool call; sources list which
    // internal APIs actually backed the answer.
    lastConfidenceScore: { type: Number, default: null },
    lastSources: [{ type: String }],
    flaggedPromptInjection: { type: Boolean, default: false },
    summary: { type: String, default: null },
    archivedAt: { type: Date, default: null }
  },
  { timestamps: true }
);

AIConversationSchema.index({ tenantId: 1, userId: 1, status: 1, updatedAt: -1 });

export default mongoose.models.AIConversation || mongoose.model("AIConversation", AIConversationSchema);
