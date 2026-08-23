import { GoogleGenAI } from "@google/genai";
import BaseAIProviderAdapter from "./BaseAIProviderAdapter.js";
import { getAIConfig } from "../../utils/aiConfig.js";

/**
 * Gap 1.6 (Multi-LLM Router provider coverage) — real Google Gemini adapter
 * via the current, unified `@google/genai` SDK (the older
 * `@google/generative-ai` package this codebase's own earlier deferral
 * comments named is deprecated). A dedicated adapter, not routed through
 * OpenAICompatibleAdapter — Gemini's REST surface (contents/parts,
 * systemInstruction, functionCalls, usageMetadata) is genuinely different
 * from the OpenAI-compatible chat-completions shape the five
 * OpenAICompatibleAdapter-served providers share, same reasoning that
 * already gave OpenAI/Anthropic/AzureOpenAI their own adapters. Mirrors
 * those three adapters' exact house style: self-constructs from
 * getAIConfig().gemini, `isConfigured()`/`checkHealth()` reflect real
 * client state, and `usage`/`finishReason` are passed through in this
 * provider's own native shape (Anthropic's own `end_turn` vs OpenAI's
 * `stop` already established that this codebase never normalizes these
 * across providers — see AIModelRouterService's own request-metric fields,
 * which store them as opaque per-provider strings).
 */
class GeminiAdapter extends BaseAIProviderAdapter {
  constructor() {
    super("Gemini");
    const config = getAIConfig();
    this.config = config.gemini;
    this.client = this.config.apiKey
      ? new GoogleGenAI({ apiKey: this.config.apiKey, httpOptions: { timeout: config.requestTimeoutMs } })
      : null;
  }

  isConfigured() {
    return Boolean(this.client);
  }

  /** `model` optionally overrides the configured GEMINI_MODEL for this one call (how AIModelRouterService pins a specific A/B-test variant), same convention as OpenAIAdapter/OpenAICompatibleAdapter. */
  async chatWithTools({ messages, tools = [], systemPrompt, model }) {
    if (!this.client) {
      throw new Error("Gemini provider is not configured (GEMINI_API_KEY missing).");
    }

    // Gemini has no "system"/"assistant" role in `contents` — a plain
    // string systemInstruction (config, below) covers the system prompt,
    // and "assistant" maps to Gemini's own "model" role. This codebase's
    // own chatWithTools contract never passes a "tool" role message
    // (AIAssistantService folds a tool result back in as a "user"-role
    // message describing it — see its own history.push call), so no
    // third role mapping is needed here.
    const contents = messages.map((m) => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.content || "" }] }));

    // Real JSON Schema accepted directly via parametersJsonSchema — no
    // uppercase-type-enum conversion needed, unlike the raw Gemini REST API.
    const functionDeclarations = tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      parametersJsonSchema: tool.parameters
    }));

    const response = await this.client.models.generateContent({
      model: model || this.config.model,
      contents,
      config: {
        systemInstruction: systemPrompt,
        maxOutputTokens: getAIConfig().maxOutputTokens,
        tools: functionDeclarations.length > 0 ? [{ functionDeclarations }] : undefined
      }
    });

    const toolCalls = (response.functionCalls || []).map((call, index) => ({
      id: call.id || `gemini-call-${index}`,
      name: call.name,
      arguments: call.args || {}
    }));

    return {
      content: response.text || null,
      toolCalls,
      finishReason: response.candidates?.[0]?.finishReason || "STOP",
      usage: response.usageMetadata || {}
    };
  }

  async checkHealth() {
    return { provider: this.providerName, status: this.isConfigured() ? "UP" : "NOT_CONFIGURED", model: this.config.model };
  }
}

export default GeminiAdapter;
