import dotenv from "dotenv";
dotenv.config();

const parseFloatSafe = (value, fallback) => {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const parseNumber = (value, fallback) => {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const parseJsonArray = (value, fallback) => {
  if (!value) return fallback;
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : fallback;
  } catch {
    return fallback;
  }
};

const parseBool = (value, fallback) => (value === undefined ? fallback : String(value).toLowerCase() === "true");

/**
 * EXT-034 "AI Model Management & Multi-LLM Routing" — the real Model
 * Registry (§12 "Model Versioning", §13 "Capability Matrix"). Every entry
 * here is a genuinely wired provider: OpenAI/Anthropic/AzureOpenAI use
 * their own dedicated adapters (unchanged since earlier EXT documents);
 * DeepSeek/Qwen/Mistral/Ollama/OpenRouter are all real, documented
 * OpenAI-compatible chat-completions APIs, so they're served by ONE
 * generic `OpenAICompatibleAdapter` (services/ai/OpenAICompatibleAdapter.js)
 * parameterized per provider — exactly "Every provider implements the same
 * interface... new providers added without architecture changes" (§4/§21),
 * using the SAME `openai` npm SDK already a dependency of this codebase
 * rather than hand-rolling HTTP calls.
 *
 * Gap 1.6 (Multi-LLM Router provider coverage) — Google Gemini is now a
 * real catalog entry, served by its own services/ai/GeminiAdapter.js (the
 * current, unified `@google/genai` SDK — genuinely non-OpenAI-compatible,
 * so it needed its own adapter, not OpenAICompatibleAdapter). Exactly one
 * adapter class + one catalog entry, no router/architecture change — which
 * was always the whole point of this document's own design.
 *
 * §13 "Tool Calling" capability is deliberately conservative for the new
 * OpenAI-compatible providers: `false` unless explicitly enabled via env
 * (`AI_MODEL_<PROVIDER>_TOOL_CALLING=true`). Real tool/function-calling
 * reliability varies a lot across models served this way (especially
 * self-hosted Ollama models) — claiming support that isn't dependable
 * would let the router hand a tool-requiring chat turn to a model that
 * silently ignores the tools it was given. They're still real, eligible
 * candidates for the categories that never need tool calling (planning,
 * reasoning synthesis, code) where this risk doesn't apply.
 */
export const getAIModelConfig = () => {
  const providers = {
    OpenAI: {
      enabled: Boolean(process.env.OPENAI_API_KEY),
      apiKey: process.env.OPENAI_API_KEY || null,
      model: process.env.OPENAI_MODEL || "gpt-4o-mini",
      categories: parseJsonArray(process.env.AI_MODEL_OPENAI_CATEGORIES_JSON, ["general_chat", "fast", "planning", "reasoning", "code"]),
      capabilities: { toolCalling: true, streaming: true, vision: false, jsonMode: true, longContext: true },
      costPerThousandTokens: { input: parseFloatSafe(process.env.AI_COST_OPENAI_INPUT_PER_1K, 0.00015), output: parseFloatSafe(process.env.AI_COST_OPENAI_OUTPUT_PER_1K, 0.0006) },
      priority: parseNumber(process.env.AI_MODEL_OPENAI_PRIORITY, 10)
    },
    Anthropic: {
      enabled: Boolean(process.env.ANTHROPIC_API_KEY),
      apiKey: process.env.ANTHROPIC_API_KEY || null,
      model: process.env.ANTHROPIC_MODEL || "claude-3-5-sonnet-latest",
      categories: parseJsonArray(process.env.AI_MODEL_ANTHROPIC_CATEGORIES_JSON, ["general_chat", "planning", "reasoning", "code"]),
      capabilities: { toolCalling: true, streaming: true, vision: false, jsonMode: false, longContext: true },
      costPerThousandTokens: { input: parseFloatSafe(process.env.AI_COST_ANTHROPIC_INPUT_PER_1K, 0.003), output: parseFloatSafe(process.env.AI_COST_ANTHROPIC_OUTPUT_PER_1K, 0.015) },
      priority: parseNumber(process.env.AI_MODEL_ANTHROPIC_PRIORITY, 20)
    },
    AzureOpenAI: {
      enabled: Boolean(process.env.AZURE_OPENAI_API_KEY && process.env.AZURE_OPENAI_ENDPOINT && process.env.AZURE_OPENAI_DEPLOYMENT),
      // No per-call model override for Azure — a deployment IS bound to one
      // specific model by Azure's own design, unlike OpenAI/Anthropic/the
      // compatible providers below where `model` is just a request field.
      model: process.env.AZURE_OPENAI_DEPLOYMENT || null,
      categories: parseJsonArray(process.env.AI_MODEL_AZURE_CATEGORIES_JSON, ["general_chat", "fast", "planning", "reasoning", "code"]),
      capabilities: { toolCalling: true, streaming: true, vision: false, jsonMode: true, longContext: true },
      costPerThousandTokens: { input: parseFloatSafe(process.env.AI_COST_AZURE_INPUT_PER_1K, 0.00015), output: parseFloatSafe(process.env.AI_COST_AZURE_OUTPUT_PER_1K, 0.0006) },
      priority: parseNumber(process.env.AI_MODEL_AZURE_PRIORITY, 30)
    },
    // Gap 1.6 — real Google Gemini support (services/ai/GeminiAdapter.js).
    // costPerThousandTokens defaults approximate gemini-2.5-flash's public
    // per-token pricing at the time this was added; like every other
    // provider here, override via env (AI_COST_GEMINI_*) rather than
    // trusting this to stay current.
    Gemini: {
      enabled: Boolean(process.env.GEMINI_API_KEY),
      apiKey: process.env.GEMINI_API_KEY || null,
      model: process.env.GEMINI_MODEL || "gemini-2.5-flash",
      categories: parseJsonArray(process.env.AI_MODEL_GEMINI_CATEGORIES_JSON, ["general_chat", "fast", "planning", "reasoning", "code"]),
      capabilities: { toolCalling: true, streaming: true, vision: false, jsonMode: true, longContext: true },
      costPerThousandTokens: { input: parseFloatSafe(process.env.AI_COST_GEMINI_INPUT_PER_1K, 0.0003), output: parseFloatSafe(process.env.AI_COST_GEMINI_OUTPUT_PER_1K, 0.0025) },
      priority: parseNumber(process.env.AI_MODEL_GEMINI_PRIORITY, 35)
    },
    DeepSeek: {
      enabled: Boolean(process.env.DEEPSEEK_API_KEY),
      apiKey: process.env.DEEPSEEK_API_KEY || null,
      baseUrl: process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com/v1",
      model: process.env.DEEPSEEK_MODEL || "deepseek-chat",
      categories: parseJsonArray(process.env.AI_MODEL_DEEPSEEK_CATEGORIES_JSON, ["general_chat", "fast", "low_cost", "code", "reasoning"]),
      capabilities: { toolCalling: parseBool(process.env.AI_MODEL_DEEPSEEK_TOOL_CALLING, false), streaming: true, vision: false, jsonMode: true, longContext: true },
      costPerThousandTokens: { input: parseFloatSafe(process.env.AI_COST_DEEPSEEK_INPUT_PER_1K, 0.00014), output: parseFloatSafe(process.env.AI_COST_DEEPSEEK_OUTPUT_PER_1K, 0.00028) },
      priority: parseNumber(process.env.AI_MODEL_DEEPSEEK_PRIORITY, 40)
    },
    Qwen: {
      enabled: Boolean(process.env.QWEN_API_KEY),
      apiKey: process.env.QWEN_API_KEY || null,
      baseUrl: process.env.QWEN_BASE_URL || "https://dashscope.aliyuncs.com/compatible-mode/v1",
      model: process.env.QWEN_MODEL || "qwen-plus",
      categories: parseJsonArray(process.env.AI_MODEL_QWEN_CATEGORIES_JSON, ["general_chat", "fast", "low_cost", "code"]),
      capabilities: { toolCalling: parseBool(process.env.AI_MODEL_QWEN_TOOL_CALLING, false), streaming: true, vision: false, jsonMode: true, longContext: true },
      costPerThousandTokens: { input: parseFloatSafe(process.env.AI_COST_QWEN_INPUT_PER_1K, 0.0004), output: parseFloatSafe(process.env.AI_COST_QWEN_OUTPUT_PER_1K, 0.0012) },
      priority: parseNumber(process.env.AI_MODEL_QWEN_PRIORITY, 50)
    },
    Mistral: {
      enabled: Boolean(process.env.MISTRAL_API_KEY),
      apiKey: process.env.MISTRAL_API_KEY || null,
      baseUrl: process.env.MISTRAL_BASE_URL || "https://api.mistral.ai/v1",
      model: process.env.MISTRAL_MODEL || "mistral-small-latest",
      categories: parseJsonArray(process.env.AI_MODEL_MISTRAL_CATEGORIES_JSON, ["general_chat", "fast", "code"]),
      capabilities: { toolCalling: parseBool(process.env.AI_MODEL_MISTRAL_TOOL_CALLING, false), streaming: true, vision: false, jsonMode: true, longContext: false },
      costPerThousandTokens: { input: parseFloatSafe(process.env.AI_COST_MISTRAL_INPUT_PER_1K, 0.0002), output: parseFloatSafe(process.env.AI_COST_MISTRAL_OUTPUT_PER_1K, 0.0006) },
      priority: parseNumber(process.env.AI_MODEL_MISTRAL_PRIORITY, 60)
    },
    OpenRouter: {
      enabled: Boolean(process.env.OPENROUTER_API_KEY),
      apiKey: process.env.OPENROUTER_API_KEY || null,
      baseUrl: process.env.OPENROUTER_BASE_URL || "https://openrouter.ai/api/v1",
      model: process.env.OPENROUTER_MODEL || "meta-llama/llama-3.1-70b-instruct",
      categories: parseJsonArray(process.env.AI_MODEL_OPENROUTER_CATEGORIES_JSON, ["general_chat", "fast", "planning", "reasoning", "code"]),
      capabilities: { toolCalling: parseBool(process.env.AI_MODEL_OPENROUTER_TOOL_CALLING, false), streaming: true, vision: false, jsonMode: true, longContext: true },
      costPerThousandTokens: { input: parseFloatSafe(process.env.AI_COST_OPENROUTER_INPUT_PER_1K, 0.0005), output: parseFloatSafe(process.env.AI_COST_OPENROUTER_OUTPUT_PER_1K, 0.0015) },
      priority: parseNumber(process.env.AI_MODEL_OPENROUTER_PRIORITY, 70)
    },
    // §5 "Local Llama, Ollama" — a self-hosted, typically-free endpoint.
    // `enabled` keys off OLLAMA_BASE_URL (not an API key — Ollama has none
    // by default); the SDK still requires a non-empty apiKey string, so a
    // harmless placeholder is used when one isn't configured.
    Ollama: {
      enabled: Boolean(process.env.OLLAMA_BASE_URL),
      apiKey: process.env.OLLAMA_API_KEY || "ollama",
      baseUrl: process.env.OLLAMA_BASE_URL || "http://localhost:11434/v1",
      model: process.env.OLLAMA_MODEL || "llama3",
      categories: parseJsonArray(process.env.AI_MODEL_OLLAMA_CATEGORIES_JSON, ["general_chat", "fast", "low_cost"]),
      capabilities: { toolCalling: parseBool(process.env.AI_MODEL_OLLAMA_TOOL_CALLING, false), streaming: true, vision: false, jsonMode: false, longContext: false },
      costPerThousandTokens: { input: 0, output: 0 },
      priority: parseNumber(process.env.AI_MODEL_OLLAMA_PRIORITY, 80)
    }
  };

  return {
    providers,
    // §8 "Provider Ranking" default order before any tenant routing policy
    // or A/B test override is applied — ascending priority number wins.
    defaultRoutingOrder: parseJsonArray(
      process.env.AI_MODEL_DEFAULT_ROUTING_ORDER_JSON,
      Object.keys(providers).sort((a, b) => providers[a].priority - providers[b].priority)
    ),
    // §7 "Model Categories" — the closed set every AIRoutingPolicyModel/
    // AIABTestModel `category` field is validated against.
    categories: ["reasoning", "general_chat", "fast", "low_cost", "vision", "embedding", "speech", "code", "planning"],
    // §19 "Security" — routing/A-B-test/promotion management is gated
    // behind a dedicated permission (or admin), same pattern as every
    // other manage-permission in this AI module.
    managePermission: process.env.AI_MODEL_MANAGE_PERMISSION || "ai.model.manage"
  };
};

export default getAIModelConfig;
