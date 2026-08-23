import test from "node:test";
import assert from "node:assert/strict";
import OpenAICompatibleAdapter from "../services/ai/OpenAICompatibleAdapter.js";
import AIModelRouterService from "../services/ai/AIModelRouterService.js";
import { getAIModelConfig } from "../utils/aiModelConfig.js";

// Gap 1.6 "Multi-LLM Router: provider list incomplete vs. spec" — traced,
// NOT rebuilt: DeepSeek/Qwen/Mistral/OpenRouter/Ollama are already real
// catalog entries (utils/aiModelConfig.js) served by the shared
// OpenAICompatibleAdapter, already wired into AIModelRouterService._getAdapter.
// No live API key for any of these five providers exists in this
// environment's .env, so this is a structural/contract conformance test
// (request/response shape mapping against a stubbed transport) — never a
// claim of a real network call against any live provider endpoint.

const COMPATIBLE_PROVIDERS = ["DeepSeek", "Qwen", "Mistral", "OpenRouter", "Ollama"];

test("aiModelConfig catalog: DeepSeek/Qwen/Mistral/OpenRouter/Ollama are real entries with categories/capabilities/cost, not placeholders", () => {
  const { providers } = getAIModelConfig();
  for (const name of COMPATIBLE_PROVIDERS) {
    const p = providers[name];
    assert.ok(p, `${name} must be a real catalog entry`);
    assert.ok(Array.isArray(p.categories) && p.categories.length > 0, `${name} must declare at least one real category`);
    assert.equal(typeof p.capabilities.toolCalling, "boolean");
    assert.equal(typeof p.capabilities.streaming, "boolean");
    assert.ok(p.model, `${name} must have a default model configured`);
  }
});

test("aiModelConfig: tool-calling defaults to false for every OpenAI-compatible provider unless explicitly opted in via env (conservative-by-default per the catalog's own documented reasoning)", () => {
  const { providers } = getAIModelConfig();
  for (const name of COMPATIBLE_PROVIDERS) {
    assert.equal(providers[name].capabilities.toolCalling, false, `${name} tool-calling must default to false with no AI_MODEL_${name.toUpperCase()}_TOOL_CALLING env override`);
  }
});

test("aiModelConfig: none of the five compatible providers is 'enabled' with no credentials configured in this environment (real, not fabricated, eligibility gate)", () => {
  const { providers } = getAIModelConfig();
  for (const name of COMPATIBLE_PROVIDERS) {
    assert.equal(providers[name].enabled, false, `${name} must not be enabled without its own real API key/base URL configured`);
  }
});

test("AIModelRouterService._getAdapter routes every compatible provider through the SAME shared OpenAICompatibleAdapter class, never a bespoke one", () => {
  for (const name of COMPATIBLE_PROVIDERS) {
    const adapter = AIModelRouterService._getAdapter(name);
    assert.ok(adapter instanceof OpenAICompatibleAdapter, `${name} must be served by OpenAICompatibleAdapter`);
    assert.equal(adapter.providerName, name);
  }
});

test("OpenAICompatibleAdapter.isConfigured reflects whether a real apiKey+baseUrl were supplied", () => {
  assert.equal(new OpenAICompatibleAdapter({ providerName: "Test", apiKey: null, baseUrl: null, model: "m" }).isConfigured(), false);
  assert.equal(new OpenAICompatibleAdapter({ providerName: "Test", apiKey: "k", baseUrl: "https://example.com/v1", model: "m" }).isConfigured(), true);
});

test("OpenAICompatibleAdapter.chatWithTools: real request/response shape conformance — tools mapped to OpenAI function-calling format, toolCalls/finishReason/usage parsed back out (stubbed transport, no live network call)", async () => {
  const adapter = new OpenAICompatibleAdapter({ providerName: "DeepSeek", apiKey: "fake-key", baseUrl: "https://api.deepseek.com/v1", model: "deepseek-chat" });

  let capturedRequest = null;
  adapter.client = {
    chat: {
      completions: {
        create: async (request) => {
          capturedRequest = request;
          return {
            choices: [{
              message: { content: null, tool_calls: [{ id: "call_1", function: { name: "flight_search", arguments: '{"origin":"KHI"}' } }] },
              finish_reason: "tool_calls"
            }],
            usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
          };
        }
      }
    }
  };

  const result = await adapter.chatWithTools({
    messages: [{ role: "user", content: "find me a flight" }],
    tools: [{ name: "flight_search", description: "search flights", parameters: { type: "object", properties: {} } }],
    systemPrompt: "You are a travel assistant."
  });

  assert.equal(capturedRequest.model, "deepseek-chat");
  assert.equal(capturedRequest.messages[0].role, "system");
  assert.equal(capturedRequest.messages[0].content, "You are a travel assistant.");
  assert.equal(capturedRequest.messages[1].content, "find me a flight");
  assert.equal(capturedRequest.tools[0].type, "function");
  assert.equal(capturedRequest.tools[0].function.name, "flight_search");

  assert.equal(result.content, null);
  assert.equal(result.finishReason, "tool_calls");
  assert.equal(result.toolCalls.length, 1);
  assert.equal(result.toolCalls[0].name, "flight_search");
  assert.deepEqual(result.toolCalls[0].arguments, { origin: "KHI" });
  assert.equal(result.usage.total_tokens, 15);
});

test("OpenAICompatibleAdapter.chatWithTools: a malformed tool_call.arguments JSON string never throws — falls back to {}, matching this codebase's own 'never crash on a provider's malformed output' standard", async () => {
  const adapter = new OpenAICompatibleAdapter({ providerName: "Mistral", apiKey: "fake-key", baseUrl: "https://api.mistral.ai/v1", model: "mistral-small-latest" });
  adapter.client = {
    chat: { completions: { create: async () => ({ choices: [{ message: { content: null, tool_calls: [{ id: "call_1", function: { name: "x", arguments: "not-json" } }] }, finish_reason: "tool_calls" }], usage: {} }) } }
  };
  const result = await adapter.chatWithTools({ messages: [{ role: "user", content: "hi" }], tools: [], systemPrompt: "s" });
  assert.deepEqual(result.toolCalls[0].arguments, {});
});

test("OpenAICompatibleAdapter.chatWithTools throws a clear error when not configured, rather than a raw SDK crash", async () => {
  const adapter = new OpenAICompatibleAdapter({ providerName: "Qwen", apiKey: null, baseUrl: null, model: "qwen-plus" });
  await assert.rejects(() => adapter.chatWithTools({ messages: [], tools: [], systemPrompt: "s" }), /not configured/);
});
