import test from "node:test";
import assert from "node:assert/strict";
import GeminiAdapter from "../services/ai/GeminiAdapter.js";
import AIModelRouterService from "../services/ai/AIModelRouterService.js";
import { getAIModelConfig } from "../utils/aiModelConfig.js";

// Gap 1.6 "Multi-LLM Router: provider list incomplete" — Google Gemini,
// built via the real @google/genai SDK. No GEMINI_API_KEY exists in this
// environment's .env, so this is a structural/contract conformance test
// (request/response shape mapping against a stubbed transport, verified
// field-for-field against the actually-installed package's own .d.ts type
// definitions) — never a claim of a real network call against Gemini's
// live API.

test("aiModelConfig catalog: Gemini is a real entry with categories/capabilities/cost", () => {
  const { providers } = getAIModelConfig();
  const p = providers.Gemini;
  assert.ok(p, "Gemini must be a real catalog entry");
  assert.ok(Array.isArray(p.categories) && p.categories.length > 0);
  assert.equal(typeof p.capabilities.toolCalling, "boolean");
  assert.ok(p.model);
});

test("aiModelConfig: Gemini is not enabled with no GEMINI_API_KEY configured in this environment", () => {
  const { providers } = getAIModelConfig();
  assert.equal(providers.Gemini.enabled, false);
});

test("AIModelRouterService._getAdapter('Gemini') returns a real GeminiAdapter instance, not OpenAICompatibleAdapter", () => {
  const adapter = AIModelRouterService._getAdapter("Gemini");
  assert.ok(adapter instanceof GeminiAdapter);
  assert.equal(adapter.providerName, "Gemini");
});

test("GeminiAdapter.isConfigured reflects whether a real apiKey was supplied", () => {
  const configured = new GeminiAdapter();
  // No GEMINI_API_KEY in this environment's .env.
  assert.equal(configured.isConfigured(), false);
});

test("GeminiAdapter.chatWithTools throws a clear error when not configured, rather than a raw SDK crash", async () => {
  const adapter = new GeminiAdapter();
  await assert.rejects(() => adapter.chatWithTools({ messages: [], tools: [], systemPrompt: "s" }), /not configured/);
});

test("GeminiAdapter.chatWithTools: real request/response shape conformance — messages mapped to Gemini's contents/parts with assistant->model role remap, tools mapped via parametersJsonSchema (plain JSON Schema, no case conversion), functionCalls/text/usageMetadata parsed back out (stubbed transport, no live network call)", async () => {
  const adapter = new GeminiAdapter();
  // Force-configure without a real key — this test only exercises the
  // request/response mapping logic via a stubbed client.
  adapter.client = {
    models: {
      generateContent: async (request) => {
        adapter._capturedRequest = request;
        return {
          text: "Here are some flights.",
          functionCalls: [{ id: "call_1", name: "flight_search", args: { origin: "KHI" } }],
          candidates: [{ finishReason: "STOP" }],
          usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 8, totalTokenCount: 20 }
        };
      }
    }
  };
  adapter.config = { model: "gemini-2.5-flash" };

  const result = await adapter.chatWithTools({
    messages: [{ role: "user", content: "find me a flight" }, { role: "assistant", content: "Sure, where from?" }, { role: "user", content: "Karachi" }],
    tools: [{ name: "flight_search", description: "search flights", parameters: { type: "object", properties: { origin: { type: "string" } } } }],
    systemPrompt: "You are a travel assistant."
  });

  const req = adapter._capturedRequest;
  assert.equal(req.model, "gemini-2.5-flash");
  assert.equal(req.config.systemInstruction, "You are a travel assistant.");
  assert.equal(req.contents[0].role, "user");
  assert.equal(req.contents[0].parts[0].text, "find me a flight");
  assert.equal(req.contents[1].role, "model", "assistant must be remapped to Gemini's own 'model' role");
  assert.equal(req.contents[1].parts[0].text, "Sure, where from?");
  assert.equal(req.contents[2].role, "user");
  assert.equal(req.config.tools[0].functionDeclarations[0].name, "flight_search");
  assert.deepEqual(req.config.tools[0].functionDeclarations[0].parametersJsonSchema, { type: "object", properties: { origin: { type: "string" } } });

  assert.equal(result.content, "Here are some flights.");
  assert.equal(result.finishReason, "STOP");
  assert.equal(result.toolCalls.length, 1);
  assert.equal(result.toolCalls[0].name, "flight_search");
  assert.deepEqual(result.toolCalls[0].arguments, { origin: "KHI" });
  assert.equal(result.usage.totalTokenCount, 20);
});

test("GeminiAdapter.chatWithTools: no tools supplied omits config.tools entirely, matching every other adapter's own 'undefined when empty' convention", async () => {
  const adapter = new GeminiAdapter();
  adapter.client = { models: { generateContent: async (request) => { adapter._capturedRequest = request; return { text: "hi", functionCalls: [], candidates: [{ finishReason: "STOP" }], usageMetadata: {} }; } } };
  adapter.config = { model: "gemini-2.5-flash" };
  await adapter.chatWithTools({ messages: [{ role: "user", content: "hi" }], tools: [], systemPrompt: "s" });
  assert.equal(adapter._capturedRequest.config.tools, undefined);
});

test("GeminiAdapter.chatWithTools: a response with no functionCalls/text yields an honest null content and empty toolCalls, never fabricated", async () => {
  const adapter = new GeminiAdapter();
  adapter.client = { models: { generateContent: async () => ({ text: undefined, functionCalls: undefined, candidates: [], usageMetadata: {} }) } };
  adapter.config = { model: "gemini-2.5-flash" };
  const result = await adapter.chatWithTools({ messages: [{ role: "user", content: "hi" }], tools: [], systemPrompt: "s" });
  assert.equal(result.content, null);
  assert.deepEqual(result.toolCalls, []);
  assert.equal(result.finishReason, "STOP", "falls back to the same default every other adapter uses when the provider omits it");
});
