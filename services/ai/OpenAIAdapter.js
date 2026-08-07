import OpenAI from "openai";
import BaseAIProviderAdapter from "./BaseAIProviderAdapter.js";
import { getAIConfig } from "../../utils/aiConfig.js";

/**
 * Real OpenAI Chat Completions adapter with native function/tool calling.
 * Returns `configured: false` behavior (via a thrown, clearly-labeled
 * error) when no API key is set — the orchestrator surfaces this as an
 * honest "AI service not configured" response, never a fabricated answer.
 */
class OpenAIAdapter extends BaseAIProviderAdapter {
  constructor() {
    super("OpenAI");
    const config = getAIConfig();
    this.config = config.openai;
    this.client = this.config.apiKey
      ? new OpenAI({ apiKey: this.config.apiKey, baseURL: this.config.baseUrl, timeout: config.requestTimeoutMs })
      : null;
  }

  isConfigured() {
    return Boolean(this.client);
  }

  /** EXT-034 — `model` optionally overrides the configured OPENAI_MODEL for this one call (how AIModelRouterService pins a specific A/B-test variant). */
  async chatWithTools({ messages, tools = [], systemPrompt, model }) {
    if (!this.client) {
      throw new Error("OpenAI provider is not configured (OPENAI_API_KEY missing).");
    }

    const openAiMessages = [
      { role: "system", content: systemPrompt },
      ...messages.map((m) => ({ role: m.role, content: m.content }))
    ];

    const openAiTools = tools.map((tool) => ({
      type: "function",
      function: { name: tool.name, description: tool.description, parameters: tool.parameters }
    }));

    const response = await this.client.chat.completions.create({
      model: model || this.config.model,
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
    return { provider: this.providerName, status: this.isConfigured() ? "UP" : "NOT_CONFIGURED", model: this.config.model };
  }
}

export default OpenAIAdapter;
