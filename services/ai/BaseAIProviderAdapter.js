/**
 * Base AI Provider Adapter Interface — "Provider Independent". All LLM
 * provider adapters (OpenAI, Anthropic, ...) must implement this contract.
 * Mirrors services/gds/BaseGdsAdapter.js's pattern deliberately, for the
 * same reason: one normalized shape in, one normalized shape out, so the
 * orchestrator never depends on a specific vendor's SDK response shape.
 */
class BaseAIProviderAdapter {
  constructor(providerName) {
    this.providerName = providerName;
  }

  /**
   * @param {object} params
   * @param {Array<{role: string, content: string}>} params.messages
   * @param {Array<object>} params.tools - JSON-schema tool/function definitions
   * @param {string} params.systemPrompt
   * @returns {Promise<{content: string|null, toolCalls: Array<{id: string, name: string, arguments: object}>, finishReason: string, usage: object}>}
   */
  async chatWithTools({ messages, tools, systemPrompt }) {
    throw new Error(`chatWithTools() not implemented in ${this.providerName}`);
  }

  async checkHealth() {
    return { provider: this.providerName, status: "UP" };
  }
}

export default BaseAIProviderAdapter;
