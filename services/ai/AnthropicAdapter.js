import Anthropic from "@anthropic-ai/sdk";
import BaseAIProviderAdapter from "./BaseAIProviderAdapter.js";
import { getAIConfig } from "../../utils/aiConfig.js";

/**
 * Real Anthropic Messages API adapter with native tool use.
 */
class AnthropicAdapter extends BaseAIProviderAdapter {
  constructor() {
    super("Anthropic");
    const config = getAIConfig();
    this.config = config.anthropic;
    this.client = this.config.apiKey
      ? new Anthropic({ apiKey: this.config.apiKey, timeout: config.requestTimeoutMs })
      : null;
  }

  isConfigured() {
    return Boolean(this.client);
  }

  async chatWithTools({ messages, tools = [], systemPrompt }) {
    if (!this.client) {
      throw new Error("Anthropic provider is not configured (ANTHROPIC_API_KEY missing).");
    }

    const anthropicTools = tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.parameters
    }));

    const response = await this.client.messages.create({
      model: this.config.model,
      system: systemPrompt,
      max_tokens: getAIConfig().maxOutputTokens,
      messages: messages.map((m) => ({ role: m.role === "assistant" ? "assistant" : "user", content: m.content })),
      tools: anthropicTools.length > 0 ? anthropicTools : undefined
    });

    const textBlocks = (response.content || []).filter((block) => block.type === "text").map((block) => block.text);
    const toolCalls = (response.content || [])
      .filter((block) => block.type === "tool_use")
      .map((block) => ({ id: block.id, name: block.name, arguments: block.input || {} }));

    return {
      content: textBlocks.length > 0 ? textBlocks.join("\n") : null,
      toolCalls,
      finishReason: response.stop_reason || "end_turn",
      usage: response.usage || {}
    };
  }

  async checkHealth() {
    return { provider: this.providerName, status: this.isConfigured() ? "UP" : "NOT_CONFIGURED", model: this.config.model };
  }
}

export default AnthropicAdapter;
