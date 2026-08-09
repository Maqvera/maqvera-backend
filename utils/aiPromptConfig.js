import dotenv from "dotenv";
dotenv.config();

const parseNumber = (value, fallback) => {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const parseJson = (value, fallback) => {
  if (!value) return fallback;
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : fallback;
  } catch {
    return fallback;
  }
};

/**
 * EXT-031 "AI Prompt Management & System Instructions" configuration.
 * Config-driven per this codebase's own convention (CLAUDE.md
 * "Config-driven domain values").
 */
export const getAIPromptConfig = () => ({
  // §5 "Prompt Types" — "User Prompt" is deliberately excluded: it's the
  // live end-user message itself, never something authored/versioned/
  // published. "Tool Prompt" (Available Tools/Input/Output Schema) is
  // also excluded as its own stored type — that's already real, dynamic,
  // and always-current via AIToolRegistry.getCatalog(); storing a
  // separate, editable copy of it here would risk it drifting out of
  // sync with the tools that actually exist.
  promptTypes: ["system", "role", "workflow", "rag", "guardrail", "evaluation", "developer"],

  // §12 "Prompt Lifecycle — Draft -> Review -> Testing -> Approved ->
  // Published -> Archived." A real state machine (see
  // AIPromptService.ALLOWED_TRANSITIONS), not a free-for-all status field —
  // enforced against exactly this list.
  lifecycleStatuses: ["draft", "review", "testing", "approved", "published", "archived", "rejected"],

  // §18 "Multi-Language Support." A requested language with no published
  // version for it honestly falls back to "en" rather than erroring or
  // fabricating a translation.
  supportedLanguages: parseJson(process.env.AI_PROMPT_SUPPORTED_LANGUAGES_JSON, ["en", "ar", "ur", "fr", "tr"]),
  defaultLanguage: process.env.AI_PROMPT_DEFAULT_LANGUAGE || "en",

  // §14 "Deployment ... Cache Refresh ... No API restart required." —
  // reuses utils/cacheManager.js (Redis or in-memory, same as the rest of
  // this codebase); publish/rollback explicitly invalidate this key so a
  // change is live on the very next request, never waiting out the TTL.
  cacheTtlSeconds: parseNumber(process.env.AI_PROMPT_CACHE_TTL_SECONDS, 300),

  // §19 "Only authorized administrators may publish prompts."
  publishPermission: process.env.AI_PROMPT_PUBLISH_PERMISSION || "ai.prompt.publish",
  managePermission: process.env.AI_PROMPT_MANAGE_PERMISSION || "ai.prompt.manage"
});

export default getAIPromptConfig;
