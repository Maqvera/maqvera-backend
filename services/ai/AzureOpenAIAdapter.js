import OpenAI from "openai";
import BaseAIProviderAdapter from "./BaseAIProviderAdapter.js";
import { getAIConfig } from "../../utils/aiConfig.js";

/**
 * Real Azure OpenAI adapter — the official `openai` SDK natively supports
 * Azure's REST surface via baseURL + api-version + api-key header, so this
 * reuses the same package as OpenAIAdapter rather than a separate SDK.
 */
class AzureOpenAIAdapter extends BaseAIProviderAdapter {
  constructor() {
    super("AzureOpenAI");
    const config = getAIConfig();
    this.config = config.azureOpenAI;
    this.client = (this.config.apiKey && this.config.endpoint && this.config.deployment)
      ? new OpenAI({
          apiKey: this.config.apiKey,
          baseURL: `${this.config.endpoint.replace(/\/$/, "")}/openai/deployments/${this.config.deployment}`,
          defaultQuery: { "api-version": this.config.apiVersion },
          defaultHeaders: { "api-key": this.config.apiKey },
          timeout: config.requestTimeoutMs
        })
      : null;
  }

  isConfigured() {
    return Boolean(this.client);
  }

  async chatWithTools({ messages, tools = [], systemPrompt }) {
    if (!this.client) {
      throw new Error("Azure OpenAI provider is not configured (AZURE_OPENAI_API_KEY/ENDPOINT/DEPLOYMENT missing).");
    }

    const openAiMessages = [{ role: "system", content: systemPrompt }, ...messages.map((m) => ({ role: m.role, content: m.content }))];
    const openAiTools = tools.map((tool) => ({ type: "function", function: { name: tool.name, description: tool.description, parameters: tool.parameters } }));

    // Azure's deployment is already baked into baseURL; `model` is ignored by Azure but required by the SDK's type.
    const response = await this.client.chat.completions.create({
      model: this.config.deployment,
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
    return { provider: this.providerName, status: this.isConfigured() ? "UP" : "NOT_CONFIGURED", deployment: this.config.deployment };
  }
}

export default AzureOpenAIAdapter;
