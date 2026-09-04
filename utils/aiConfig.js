import dotenv from "dotenv";
dotenv.config();

const parseNumber = (value, fallback) => {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const parseFloatSafe = (value, fallback) => {
  const parsed = Number.parseFloat(value);
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
 * AI Travel Assistant configuration (API-006F). "Provider Independent" —
 * mirrors the GDS module's BaseGdsAdapter/AmadeusAdapter/SabreAdapter
 * pattern: one contract, swappable real providers, no fabricated response
 * when neither provider is configured (an honest 503, not a fake answer —
 * a made-up "AI" reply would be a worse kind of dishonesty than the GDS
 * adapters' clearly-labeled dynamic sandbox data).
 */
export const getAIConfig = () => ({
  openai: {
    apiKey: process.env.OPENAI_API_KEY || null,
    model: process.env.OPENAI_MODEL || "gpt-4o-mini",
    baseUrl: process.env.OPENAI_BASE_URL || undefined,
    // Voice-Based Booking Creation PRD B3.1 — same apiKey/client this
    // provider already resolves for chatWithTools; only the model name for
    // the separate audio/transcriptions endpoint is new.
    transcriptionModel: process.env.OPENAI_TRANSCRIPTION_MODEL || "whisper-1"
  },
  anthropic: {
    apiKey: process.env.ANTHROPIC_API_KEY || null,
    model: process.env.ANTHROPIC_MODEL || "claude-3-5-sonnet-latest"
  },
  // API-006G "Supported AI Providers" also names Google Gemini and Azure
  // OpenAI. Azure is real and implemented (same `openai` SDK, different
  // base URL) since it's a light, genuine addition.
  azureOpenAI: {
    apiKey: process.env.AZURE_OPENAI_API_KEY || null,
    endpoint: process.env.AZURE_OPENAI_ENDPOINT || null,
    deployment: process.env.AZURE_OPENAI_DEPLOYMENT || null,
    apiVersion: process.env.AZURE_OPENAI_API_VERSION || "2024-08-01-preview"
  },
  // Gap 1.6 (Multi-LLM Router provider coverage) — real as of this change,
  // via the current @google/genai SDK (services/ai/GeminiAdapter.js). The
  // older @google/generative-ai package this section used to defer to is
  // itself deprecated in favor of @google/genai.
  gemini: {
    apiKey: process.env.GEMINI_API_KEY || null,
    model: process.env.GEMINI_MODEL || "gemini-2.5-flash"
  },

  // EXT-034 "AI Model Management & Multi-LLM Routing" — per-provider cost
  // rates and primary/secondary provider selection moved to
  // utils/aiModelConfig.js's real Model Registry (getAIModelConfig()),
  // which now owns the full multi-provider catalog these two fields used
  // to hardcode a two-provider version of. AIModelRouterService is the
  // only consumer of that config; nothing here reads it anymore.

  // Tool-level (not LLM-provider-level) execution policy — "Retry
  // Policies", "Execution Types", "Timeout". `toolDefaultTimeoutMs` was
  // previously only ever surfaced as catalog metadata (getCatalog()'s
  // `timeoutMs` field) — real, decorative, but never actually enforced
  // against a running tool call. EXT-029 §6/§8 "Timed Out" / "Timer" wires
  // it into a real Promise.race in AIOrchestrationService.runStep().
  toolDefaultTimeoutMs: parseNumber(process.env.AI_TOOL_DEFAULT_TIMEOUT_MS, 15000),
  toolDefaultMaxRetries: parseNumber(process.env.AI_TOOL_DEFAULT_MAX_RETRIES, 2),
  // EXT-029 §11 "Retry Strategy — Retry -> Exponential Backoff." Previously
  // a retried step fired again immediately, back-to-back, with zero delay —
  // real exponential backoff (with jitter) now separates attempts.
  retryBaseDelayMs: parseNumber(process.env.AI_RETRY_BASE_DELAY_MS, 500),
  retryBackoffMultiplier: parseFloatSafe(process.env.AI_RETRY_BACKOFF_MULTIPLIER, 2),
  retryMaxDelayMs: parseNumber(process.env.AI_RETRY_MAX_DELAY_MS, 8000),
  // EXT-029 §6/§15 "Timed Out" — a whole-execution wall-clock ceiling,
  // checked at the same cooperative checkpoint boundary EXT-028's
  // cancellation already added (see executePlan()'s group loop). Distinct
  // from toolDefaultTimeoutMs (one step) and from the crash-recovery
  // staleExecutionThresholdMs (an abandoned process, not a slow-but-alive one).
  workflowMaxDurationMs: parseNumber(process.env.AI_WORKFLOW_MAX_DURATION_MS, 30 * 60 * 1000),
  maxPlanSteps: parseNumber(process.env.AI_MAX_PLAN_STEPS, 8),

  maxOutputTokens: parseNumber(process.env.AI_MAX_OUTPUT_TOKENS, 1024),
  maxToolIterations: parseNumber(process.env.AI_MAX_TOOL_ITERATIONS, 4),
  requestTimeoutMs: parseNumber(process.env.AI_REQUEST_TIMEOUT_MS, 20000),
  maxRetries: parseNumber(process.env.AI_MAX_RETRIES, 1),
  circuitBreakerThreshold: parseNumber(process.env.AI_CIRCUIT_BREAKER_THRESHOLD, 3),
  circuitBreakerCooldownMs: parseNumber(process.env.AI_CIRCUIT_BREAKER_COOLDOWN_MS, 30000),

  // EXT-026 §13 "Rate Limiting — Every tool has User Limit, Tenant Limit,
  // Global Limit." Distinct from AIAssistantRoutes.js's own route-level
  // express-rate-limit (which throttles whole chat turns, not individual
  // tool invocations within a turn) — this is per-tool granularity, e.g.
  // limiting how often `propose_flight_booking` specifically can be
  // attempted, independent of how many chat messages are sent. "Provider
  // Limit" is deliberately not duplicated here — GdsIntegrationService's
  // own circuit breaker + AmadeusMetricsService.rateLimitedCount already
  // are the real provider-side rate-limit signal; this layer only adds
  // the AI-initiated User/Tenant/Global limits on top.
  toolRateLimitPerUserPerMinute: parseNumber(process.env.AI_TOOL_RATE_LIMIT_PER_USER_PER_MINUTE, 20),
  toolRateLimitPerTenantPerMinute: parseNumber(process.env.AI_TOOL_RATE_LIMIT_PER_TENANT_PER_MINUTE, 100),
  toolRateLimitGlobalPerMinute: parseNumber(process.env.AI_TOOL_RATE_LIMIT_GLOBAL_PER_MINUTE, 500),

  maxMessageLength: parseNumber(process.env.AI_MAX_MESSAGE_LENGTH, 4000),
  maxHistoryMessages: parseNumber(process.env.AI_MAX_HISTORY_MESSAGES, 20),
  // "Memory expires according to company policy."
  conversationRetentionDays: parseNumber(process.env.AI_CONVERSATION_RETENTION_DAYS, 90),

  // EXT-027 §10/§11/§16 "Context Lifecycle ... Default timeout
  // configurable ... Expired sessions automatically removed ... Memory
  // expires automatically." Deliberately separate from
  // conversationRetentionDays above: that governs the whole conversation's
  // long-lived retention/archival, this governs the much shorter-lived
  // structured session MEMORY (selected flight/hotel, search params, etc.)
  // going idle within an active conversation — see
  // services/ai/AIContextMemory.js and aiContextExpiryScheduler.js.
  memorySessionTimeoutMinutes: parseNumber(process.env.AI_MEMORY_SESSION_TIMEOUT_MINUTES, 60),

  // "Prompt Injection Protection" — a real, bounded heuristic (regex
  // phrase list), not a claim of foolproof detection. Flags + logs
  // suspicious prompts for audit; does not silently rewrite user input.
  promptInjectionPatterns: parseJson(process.env.AI_PROMPT_INJECTION_PATTERNS_JSON, [
    "ignore (all )?(previous|prior|above) instructions",
    "disregard (all )?(previous|prior|above) instructions",
    "you are now",
    "system prompt",
    "reveal your (instructions|prompt|system message)",
    "act as (if )?(you (are|were) )?(an? )?(unrestricted|jailbroken|dan)"
  ])
});

/**
 * EXT-036 §22 "Recovery" — crash-recovery sweep policy, kept separate from
 * getAIConfig() since it governs the workflow runtime's own maintenance
 * job, not a per-request AI behavior.
 */
export const getAIWorkflowRecoveryConfig = () => ({
  // How long an execution can sit at status "executing" with no new
  // checkpoint save before the sweep treats it as abandoned by a crashed
  // process rather than genuinely still running. Must comfortably exceed
  // the slowest realistic single parallel-group duration (external
  // provider calls, tool retries) — a threshold shorter than that would
  // resume an execution that's still legitimately in progress.
  staleExecutionThresholdMs: parseNumber(process.env.AI_WORKFLOW_RECOVERY_STALE_THRESHOLD_MS, 5 * 60 * 1000),
  sweepCronSchedule: process.env.AI_WORKFLOW_RECOVERY_CRON_SCHEDULE || "*/5 * * * *"
});

/**
 * EXT-029 §15 "Timeout Handling — Approval Timeout -> Reminder ->
 * Escalation -> Auto Cancel (Configurable)." Product decision made
 * explicitly for this build: reminder and escalation notifications fire on
 * schedule, but a pending approval is NEVER auto-rejected — a real booking/
 * cancellation proposal only ever resolves by an actual human decision.
 * No "auto cancel" threshold exists here at all, deliberately — there is
 * nothing for one to configure.
 */
export const getAIApprovalTimeoutConfig = () => ({
  reminderAfterMs: parseNumber(process.env.AI_APPROVAL_REMINDER_AFTER_MS, 2 * 60 * 60 * 1000),
  escalationAfterMs: parseNumber(process.env.AI_APPROVAL_ESCALATION_AFTER_MS, 8 * 60 * 60 * 1000),
  sweepCronSchedule: process.env.AI_APPROVAL_TIMEOUT_CRON_SCHEDULE || "*/15 * * * *"
});

// Gap 1.2 "AI Conversation retention config is dead" — conversationRetentionDays
// above has always been read into getAIConfig() but never consumed by any
// sweep (services/aiConversationRetentionScheduler.js). `retentionDays`
// deliberately reuses getAIConfig().conversationRetentionDays as the single
// source of truth rather than a second env var that could drift from it.
export const getAIConversationRetentionConfig = () => ({
  retentionDays: getAIConfig().conversationRetentionDays,
  sweepCronSchedule: process.env.AI_CONVERSATION_RETENTION_CRON_SCHEDULE || "0 3 * * *"
});

export default getAIConfig;
