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
  primaryProvider: process.env.AI_PRIMARY_PROVIDER || "OpenAI",
  secondaryProvider: process.env.AI_SECONDARY_PROVIDER || "Anthropic",

  openai: {
    apiKey: process.env.OPENAI_API_KEY || null,
    model: process.env.OPENAI_MODEL || "gpt-4o-mini",
    baseUrl: process.env.OPENAI_BASE_URL || undefined
  },
  anthropic: {
    apiKey: process.env.ANTHROPIC_API_KEY || null,
    model: process.env.ANTHROPIC_MODEL || "claude-3-5-sonnet-latest"
  },
  // API-006G "Supported AI Providers" also names Google Gemini and Azure
  // OpenAI. Azure is real and implemented (same `openai` SDK, different
  // base URL) since it's a light, genuine addition. Gemini needs a
  // separate SDK (@google/generative-ai) and is deliberately deferred —
  // both this doc's own list and API-006F/006B/006C mark less-critical
  // providers "(Future)" rather than fabricate an untested integration.
  azureOpenAI: {
    apiKey: process.env.AZURE_OPENAI_API_KEY || null,
    endpoint: process.env.AZURE_OPENAI_ENDPOINT || null,
    deployment: process.env.AZURE_OPENAI_DEPLOYMENT || null,
    apiVersion: process.env.AZURE_OPENAI_API_VERSION || "2024-08-01-preview"
  },

  // "Cost Optimization" — estimated USD per 1K tokens, provider-configurable.
  // Labeled as an estimate everywhere it's surfaced: real invoiced cost
  // depends on the provider's own billing, not this constant.
  costPerThousandTokens: {
    OpenAI: { input: parseFloatSafe(process.env.AI_COST_OPENAI_INPUT_PER_1K, 0.00015), output: parseFloatSafe(process.env.AI_COST_OPENAI_OUTPUT_PER_1K, 0.0006) },
    Anthropic: { input: parseFloatSafe(process.env.AI_COST_ANTHROPIC_INPUT_PER_1K, 0.003), output: parseFloatSafe(process.env.AI_COST_ANTHROPIC_OUTPUT_PER_1K, 0.015) },
    AzureOpenAI: { input: parseFloatSafe(process.env.AI_COST_AZURE_INPUT_PER_1K, 0.00015), output: parseFloatSafe(process.env.AI_COST_AZURE_OUTPUT_PER_1K, 0.0006) }
  },

  // Tool-level (not LLM-provider-level) execution policy — "Retry
  // Policies", "Execution Types", "Timeout".
  toolDefaultTimeoutMs: parseNumber(process.env.AI_TOOL_DEFAULT_TIMEOUT_MS, 15000),
  toolDefaultMaxRetries: parseNumber(process.env.AI_TOOL_DEFAULT_MAX_RETRIES, 2),
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

export default getAIConfig;
