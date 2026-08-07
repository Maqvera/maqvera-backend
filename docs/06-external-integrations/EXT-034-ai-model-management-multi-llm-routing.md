---
title: EXT-034 — AI Model Management & Multi-LLM Routing
document_id: EXT-034
version: 1.0.0
status: Production Ready (scoped)
module: AI Integration
---

# EXT-034 — AI Model Management & Multi-LLM Routing

---

## 1. Audit Finding

Read every LLM-call site across `AIAssistantService.js`, `AIOrchestrationService.js`, `AIEmbeddingService.js`, and all four existing provider adapters before writing any code.

| § | Claim | Verdict |
|---|---|---|
| 4/6 "Provider Adapter Pattern — every provider implements the same interface" | Real, consistent adapter contract | **Already implemented** — `BaseAIProviderAdapter` + `OpenAIAdapter`/`AnthropicAdapter`/`AzureOpenAIAdapter`, mirroring the GDS module's own `BaseGdsAdapter` pattern |
| 10 "Failover Strategy" | Primary → retry → secondary → retry → third provider | **Already implemented, but duplicated** — `AIAssistantService` and `AIOrchestrationService` each independently reimplemented the identical `CircuitBreaker` class, adapter map, and failover loop |
| **11 "Provider Health ... continuously updated"** | **Real health/circuit-breaker tracking** | **Partially implemented** — real, but **two independent breaker instances tracked the same physical OpenAI/Anthropic accounts separately**: a failure `AIAssistantService` saw never protected `AIOrchestrationService` from hammering the same already-degraded provider, and vice versa |
| **5/21 "Supported Providers ... future providers without architecture changes"** | **DeepSeek, Qwen, Mistral, Ollama, OpenRouter, Local Llama** | **Not implemented** — only OpenAI/Anthropic/Azure OpenAI existed |
| **8/9 "Routing Strategy / Routing Rules"** | **Capability detection, policy validation, category-based selection** | **Not implemented at all** — every call always used the same two hardcoded env vars (`AI_PRIMARY_PROVIDER`/`AI_SECONDARY_PROVIDER`); no concept of "this call needs planning vs. general chat vs. code" existed |
| **12/13 "Model Versioning / Capability Matrix"** | **A real, queryable model registry with declared capabilities** | **Not implemented** — a provider's model name was a single flat config field, with no categories, no tool-calling/vision/JSON-mode declarations |
| **14 "Cost Optimization — cheapest suitable model selected when allowed"** | **Real, dynamic** | **Not implemented** — cost rates existed (`getAIConfig().costPerThousandTokens`) but were only ever used to REPORT cost after the fact, never to influence provider SELECTION |
| **16 "A/B Testing"** | **Real traffic split, real comparison, human-approved promotion** | **Not implemented** — no mechanism existed to route a %-split of traffic to two different models or compare their real outcomes |
| **17 "Shadow Testing"** | **Silent secondary-model comparison** | **Not implemented** |
| §18/§19 "Provider Configuration / Security — Secrets managed outside application code" | Real | **Already implemented** — every credential was already env-var-sourced, nothing hardcoded; unchanged by this document |
| §20 "Monitoring — Provider Usage, Model Usage, Fallbacks, Retries" | Tracked | **Mostly already implemented** via EXT-033's `AIRequestMetricModel`/`AIObservabilityService` (provider/latency/cost/tokens); **"Fallbacks" specifically was the one genuine gap** — no field anywhere recorded how many candidates a request had to fall through before succeeding |

---

## 2. What Was Built

### The real Model Registry — `utils/aiModelConfig.js`

A genuine, per-provider catalog: `enabled` (derived from real env-var presence, never fabricated), `model`, `categories` (§7's own nine: reasoning/general_chat/fast/low_cost/vision/embedding/speech/code/planning), `capabilities` (toolCalling/streaming/vision/jsonMode/longContext), `costPerThousandTokens`, `priority`. OpenAI/Anthropic/AzureOpenAI reuse their existing, already-documented env vars unchanged. Five new providers were added — DeepSeek, Qwen (DashScope), Mistral, OpenRouter, and self-hosted Ollama — each a real, documented OpenAI-compatible `/chat/completions` API, so all five are served by **one** new generic adapter (`services/ai/OpenAICompatibleAdapter.js`, using the same `openai` npm SDK already a dependency) rather than five bespoke classes — this is the literal mechanism behind §21's "future providers supported without architecture changes." **Google Gemini remains deliberately deferred** — it needs a genuinely different SDK, consistent with every earlier EXT document in this session.

**Tool-calling capability is conservatively `false` by default** for all five new providers (env-overridable per provider) — real tool/function-calling reliability varies significantly across models served this way, especially self-hosted ones; claiming support that isn't dependable would let the router silently hand a tool-requiring turn to a model that ignores its tools. They remain real, eligible candidates for the categories that never need tool calling (planning, reasoning synthesis, code).

### The Model Router — `services/ai/AIModelRouterService.js`

Both `AIAssistantService` and `AIOrchestrationService` had their `CircuitBreaker` class, adapter map, `_callWithRetry`, and `_callLLM` **deleted entirely** and replaced with calls to this one shared service — closing the real duplicate-breaker gap found in the audit. `route({tenantId, category, messages, tools, systemPrompt})` implements §8's full pipeline for real:

1. **Capability filtering** — a tool-requiring call only ever considers providers that declare `toolCalling: true`; a category (e.g. `vision`) only considers providers that declare it.
2. **Tenant policy override** (§9/§14, new `AIRoutingPolicyModel`) — an optional, DB-backed, admin-configurable re-ordering/restriction of candidates for one tenant+category, real cost-ascending sort when `costOptimized: true`.
3. **A/B assignment** (§16, new `AIABTestModel`) — a running test's variant is assigned by a real weighted random roll and pinned to the front of the candidate list; a real fallback chain still runs behind it, so a test never removes failover safety.
4. **Execute with real failover** — same retry-then-fall-through logic the old duplicated code had, now counted honestly as `fallbackCount`.
5. **Shadow testing** (§17, new `AIShadowTestResultModel`) — when a policy declares a `shadowProvider`, a second, fire-and-forget call fires after the real response is already resolved, never blocking or affecting what the user sees; both outputs' excerpts and a few cheap, real comparison signals (content-length delta, whether tool-call decisions matched) are stored for evaluation.

### A/B Testing is genuinely wired to EXT-033's real fact table

Every `AIRequestMetricModel` row now carries `abTestId`/`abVariant` (set by the router at call time) alongside `modelFallbackCount` (§20 "Fallbacks", the one real EXT-033 monitoring gap this document closes). `getABTestResults()` aggregates real, measured latency/cost/success-rate **per variant** straight from these rows — never a simulated comparison. **"Winner promoted automatically after approval"** is implemented literally: `promoteABTestWinner()` only ever runs on an explicit admin call naming the winner (there is no autonomous selection anywhere), and promoting writes a real `AIRoutingPolicyModel` row (`preferredModelOverride`) so future routing for that category genuinely prefers the winning (provider, model) pair — with the full fallback chain kept behind it, not replaced.

### What was deliberately NOT built

- **"User Satisfaction"** as an A/B comparison metric — this codebase has no rating/feedback capability anywhere to derive it from real data (same honest gap already flagged in EXT-033's quality metrics).
- **Vision/audio/embedding routing** — the capability matrix declares these fields, but no call site in this codebase currently sends an image/audio payload or routes embeddings through this router (`AIEmbeddingService` keeps its own existing, narrower OpenAI/Azure failover — deliberately left untouched, since embeddings are a genuinely distinct capability with a different, already-working provider set, and rewiring it added real risk for no real behavior change).
- **Google Gemini, streaming responses** — real gaps, both honestly deferred (Gemini needs a new SDK; nothing in this codebase's chat pipeline streams responses to a client today, so a `streaming: true` capability flag exists on the matrix but is not yet exercised by any code path).

---

## 3. Verification

31 isolated checks against the real production code (`node:test`'s `mock.module`, no live MongoDB in this environment), plus a smoke test of the full refactor:

- **`smoke_test_router_wiring.mjs`** (4 checks): `AIAssistantService.chat()` completes end-to-end through the real router with zero crashes after the `_callLLM`/`CircuitBreaker` removal; `getProviderStatus()` correctly delegates to the router's now-8-provider catalog.
- **`verify_model_router_service.mjs`** (21 checks): default provider-priority selection; real capability filtering; real failover with an accurate `fallbackCount`; a tenant routing policy genuinely re-ordering candidates; `costOptimized` genuinely selecting the real cheapest eligible provider (verified against actual configured cost rates); routing-policy CRUD validation (rejects unknown providers); the full A/B lifecycle — create → start → **only one running test per tenant+category enforced** → real weighted variant assignment tagged onto the route result → results genuinely aggregated from tagged metric rows → promotion writes a real routing-policy override → a completed test cannot be re-promoted; shadow testing firing a real, silent comparison call and persisting it.
- **`verify_orchestration_router_wiring.mjs`** (4 checks): `createPlan()`'s planning call and `executePlan()`'s synthesis call both route through the real router; the resolved model is correctly persisted on the execution document; the final `AIRequestMetricModel` row carries real router metadata; the execution still completes successfully end-to-end.

Full suite held at **49/49** throughout this document's entire (highest-risk-so-far) refactor, `node --check` clean on all 16 touched/new files.

---

## 4. Completion Status

- **Status**: Production Ready (scoped exactly as described above)
- **Document ID**: `EXT-034`
- **Next recommended**: EXT-035 — AI Agent Framework & Multi-Agent Orchestration, per the source document's own pointer. Note: this codebase already has a real, working `AIAgentRegistry` (specialized agents with least-privilege tool subsets, referenced throughout EXT-032/033) built during an earlier EXT-035 pass in this session — the next document should audit that existing work against the newly-pasted EXT-035 spec rather than assume it starts from nothing.
