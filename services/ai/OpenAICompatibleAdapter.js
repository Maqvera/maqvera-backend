import OpenAI from "openai";
import BaseAIProviderAdapter from "./BaseAIProviderAdapter.js";
import { getAIConfig } from "../../utils/aiConfig.js";

/**
 * EXT-034 "Provider Adapter Pattern ... Every provider implements the same
 * interface." A single, generic adapter for the whole family of providers
 * that document a real, OpenAI-compatible `/chat/completions` endpoint —
 * DeepSeek, Qwen (DashScope compatible mode), Mistral, OpenRouter, and
 * self-hosted Ollama. Uses the SAME `openai` npm SDK the codebase's own
 * OpenAIAdapter/AzureOpenAIAdapter already depend on (just pointed at a
 * different `baseURL`), never a hand-rolled HTTP client — this is exactly
 * what lets a brand-new provider be added via one AIModelRouterService
 * catalog entry (utils/aiModelConfig.js) instead of a bespoke adapter
 * class each time.
 *
 * Unlike the other adapters, this one is constructed with explicit config
 * (not read internally from getAIConfig()) since AIModelRouterService needs
 * to instantiate several independent instances of this same class — one
 * per compatible provider.
 */
class OpenAICompatibleAdapter extends BaseAIProviderAdapter {
  constructor({ providerName, apiKey, baseUrl, model }) {
    super(providerName);
    this.model = model;
    this.client = apiKey && baseUrl
      ? new OpenAI({ apiKey, baseURL: baseUrl, timeout: getAIConfig().requestTimeoutMs })
      : null;
  }

  isConfigured() {
    return Boolean(this.client);
  }

  /** `model` optionally overrides the catalog's configured model for this call — how AIModelRouterService pins a specific A/B-test variant model. */
  async chatWithTools({ messages, tools = [], systemPrompt, model }) {
    if (!this.client) {
      throw new Error(`${this.providerName} provider is not configured (missing API key or base URL).`);
    }

    const openAiMessages = [{ role: "system", content: systemPrompt }, ...messages.map((m) => ({ role: m.role, content: m.content }))];
    const openAiTools = tools.map((tool) => ({ type: "function", function: { name: tool.name, description: tool.description, parameters: tool.parameters } }));

    const response = await this.client.chat.completions.create({
      model: model || this.model,
      messages: openAiMessages,
      tools: openAiTools.length > 0 ? openAiTools : undefined,
      max_tokens: getAIConfig().maxOutputTokens
    });

    const choice = response.choices?.[0];
    const toolCalls = (choice?.message?.tool_calls || []).map((call) => {
      let args = {};
      try { args = JSON.parse(call.function.arguments || "{}"); } catch { args = {}; }
      return { id: call.id, name: call.function.name, arguments: args };
    });

    return {
      content: choice?.message?.content || null,
      toolCalls,
      finishReason: choice?.finish_reason || "stop",
      usage: response.usage || {}
    };
  }

  async checkHealth() {
    return { provider: this.providerName, status: this.isConfigured() ? "UP" : "NOT_CONFIGURED", model: this.model };
  }
}

export default OpenAICompatibleAdapter;
