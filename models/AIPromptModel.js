import mongoose from "mongoose";

/**
 * EXT-031 "AI Prompt Management & System Instructions". A named prompt
 * "slot" — e.g. (promptType: "system", key: "default"), (promptType:
 * "role", key: "Operations"), (promptType: "workflow", key: "planning").
 * The actual versioned text lives in AIPromptVersionModel; this document
 * is mainly the stable identity + a denormalized pointer to whichever
 * version is currently live, so resolution never needs to scan every
 * version to find the published one.
 */
const AIPromptSchema = new mongoose.Schema(
  {
    tenantId: { type: String, required: true, index: true },
    promptType: { type: String, required: true, index: true },
    // Meaning depends on promptType: "default" for system/guardrail;
    // an AIConversationModel.mode value (or a custom name) for "role";
    // a workflow identifier ("planning"/"synthesis"/...) for "workflow".
    key: { type: String, required: true, index: true },
    // §18 "Multi-Language Support ... Language selected dynamically."
    // Part of this slot's identity (not just a version detail) — each
    // language is independently versioned/published/rolled-back, since a
    // tenant may want, say, the Arabic system prompt live on an older
    // wording than the English one at any given moment.
    language: { type: String, default: "en", index: true },
    name: { type: String, required: true },
    description: { type: String, default: null },
    // §11 "Rollback Version" — denormalized for O(1) resolution; the
    // authoritative version documents (including every past one) live in
    // AIPromptVersionModel and are never deleted (§19 "Prompt history immutable").
    currentPublishedVersion: { type: mongoose.Schema.Types.ObjectId, ref: "AIPromptVersion", default: null },
    createdBy: { type: String, required: true }
  },
  { timestamps: true }
);

AIPromptSchema.index({ tenantId: 1, promptType: 1, key: 1, language: 1 }, { unique: true });

export default mongoose.models.AIPrompt || mongoose.model("AIPrompt", AIPromptSchema);
