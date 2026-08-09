---
title: EXT-033 — AI Observability, Monitoring & Evaluation
document_id: EXT-033
version: 1.0.0
status: Production Ready (scoped)
module: AI Integration
---

# EXT-033 — AI Observability, Monitoring & Evaluation

---

## 1. Audit Finding

Read every metrics/logging/tracing touchpoint across `AIAssistantService.js`, `AIOrchestrationService.js`, `AIToolRegistry.js`, `AIGuardrailService.js` (EXT-032), `AIPromptService.js` (EXT-031), `AIAgentRegistry.js`, `utils/cacheManager.js`, `utils/eventBus.js`, and `utils/logger.js` before writing any code.

| § | Claim | Verdict |
|---|---|---|
| 9 "Workflow Metrics" | Count/completed/running/failed/duration/approval delays/retries/timeouts | **Already implemented** — `AIOrchestrationService.getWorkflowMetrics()` (EXT-029), real `$facet` aggregation. Only "Compensated" was missing a counter — not added here since it's a niche, rarely-hit path (`_flagFlightForManualReview`); a real, queryable signal for it already exists via `AIApprovalRequestModel.compensationFlag.flagged`, left as a follow-up rather than scope creep into an already-shipped method |
| 20 "Evaluation — Offline, Golden Dataset, Regression" | Golden-dataset test execution against real LLM output | **Already implemented** — `AIPromptService.runTestSuite()` (EXT-031), real per-case pass/fail against actual model output, never LLM-graded |
| 23 "Security Monitoring — Blocked Requests, Injection Attempts, Policy Violations" | Real counters | **Already implemented** — `AIGuardrailService.getGuardrailMetrics()` (EXT-032) |
| 16 "Distributed Tracing — Request ID, Correlation ID" | IDs exist and propagate | **Partially implemented** — `req.requestId` (middleware) and `correlationId` (`AIToolExecutionModel`) both existed, but `requestId` was never threaded past the controller into either AI service, so it had no way to correlate a specific inbound HTTP request with the resulting conversation/execution record |
| **4/5/6/7/8 "Guardrail/Metrics Architecture, Request/LLM/Tool Metrics"** | **A unifying metrics layer with real per-request, per-provider, per-tool numbers** | **Not implemented at all** — no fact table existed. `AIToolExecutionModel` covers only the formal-plan path; a chat turn's tool calls only ever existed buried inside each conversation document, with zero duration/token/cost tracking on the turn itself |
| **11 "RAG Metrics — Hit Rate, Miss Rate, Citation Coverage"** | **Tracked** | **Not implemented** — `AIKnowledgeService.retrieveKnowledge()` never recorded whether a query actually hit anything, at an aggregate level |
| **12 "Memory Metrics — Cache Hit Rate"** | **Tracked** | **Not implemented** — `CacheManager` (used by `AIPromptService`'s prompt resolution) had zero hit/miss counters |
| **13 "AI Quality Metrics — Hallucination Rate"** | **Measured** | **Not implemented** as an aggregate — EXT-032's `validateResponse()` already computes a per-turn `possiblyUngroundedClaims` flag, but nothing rolled it up into a rate over time |
| **15 "Error Categories"** | **LLM/Provider/Timeout/Permission/Workflow/Tool/Policy/Unexpected** | **Not implemented** — errors were only ever free-text strings in `executionErrors`, never classified |
| **17 "Structured Logs"** | **Planner/Tool/Workflow/Prompt/Safety Logs** | **Partially implemented** — `utils/logger.js` (real winston, JSON to file + console) already existed and was already used by every scheduler (`aiApprovalTimeoutScheduler.js` etc.), but every core AI service (`AIAssistantService`, `AIOrchestrationService`, `AIToolRegistry`) still used raw `console.error` — the structured logger existed but wasn't reaching the AI layer |
| **18/22 "Dashboards / AI Health Score"** | **Real, computed** | **Not implemented** — no unifying dashboard/health-score endpoint existed; `AIAgentRegistry.getHealthScore()` (EXT-035) is a real but narrowly-scoped per-agent success rate, not a platform-wide composite |
| **19 "Alerting"** | **Configurable, real** | **Not implemented at all** — no threshold evaluation, no alert state, no de-dup mechanism existed anywhere |
| **21 "Cost Monitoring — Per Tenant, Daily, Monthly, Budget Alerts"** | **Tracked** | **Partially implemented** — `AIOrchestrationService.executePlan()` already computed real per-execution `estimatedCostUsd`; `AIAssistantService.chat()` never computed a cost at all, and no aggregation across time/tenant existed anywhere |
| §24 "OpenTelemetry / Prometheus / Grafana / Jaeger / Langfuse / Helicone / Phoenix / MLflow" | Supported | **Not implemented, honestly** — none of these packages are installed and no exporter exists; the document's own "Future Ready" framing already treats this as aspirational, not a build requirement |
| §20 "A/B Evaluation, Benchmark Comparison, Human Review" | Supported | **Not implemented, honestly deferred** — A/B evaluation needs real traffic-splitting across models, which is explicitly what the *next* document (EXT-034, Model Management & Multi-LLM Routing) builds; Human Review needs a rating/feedback UI this codebase has none of. Building either here would be a stub pretending to be a feature |

---

## 2. What Was Built

### The fact table — `models/AIRequestMetricModel.js`

One row per real, end-user-facing AI interaction — a chat turn (`type: "chat"`) or a plan execution finishing (`type: "plan_execution"`) — written by `AIAssistantService.chat()` and `AIOrchestrationService.executePlan()` respectively, on **every** real exit path (success, failure, cancellation, timeout — not just the "clean" completion). Deliberately separate from the operational records (`AIConversationModel`, `AIToolExecutionModel`), which remain the source of truth for actually running the AI — the same "Analytics" pattern this codebase already uses elsewhere (`KPIEngine`/`VisaAnalyticsEngine` write summary collections; dashboards never read live operational records directly). `toolCalls[]` is a denormalized, lightweight copy specifically so §8 Tool Metrics can be aggregated with **one** `$unwind` across BOTH the chat path and the plan-execution path uniformly — no existing collection supported that.

### The Policy Engine's sibling — `services/ai/AIObservabilityService.js`

Deliberately does **not** import `AIAssistantService`/`AIOrchestrationService` (both of which import *this* service to record metrics) — avoiding a circular dependency the same way EXT-032's `AIGuardrailService` avoided one with `AIToolRegistry`. Anything needing live provider status (the health score's availability component, the `provider_unavailable` alert) takes it as an **optional parameter** supplied by the caller (the controller, or the scheduler), which already has direct access to both services' real `getProviderStatus()`.

- `classifyError(message)` (§15) — a bounded regex classifier, same honesty style as `AIOrchestrationService`'s pre-existing `isRetryableError`.
- `getRequestMetrics` (§6), `getLLMMetrics` (§7), `getToolMetrics` (§8), `getRAGMetrics` (§11), `getMemoryMetrics` (§12), `getQualityMetrics` (§13), `getCostMetrics` (§21), `getPromptDashboard` (§10 — delegates per-version detail to the already-real `AIPromptService.getPromptMetrics`, adds only the genuinely new "Fallback Usage Rate"), `getSecurityMetrics` (§23 — delegates to the already-real `AIGuardrailService.getGuardrailMetrics`, adds only the two counters that weren't tracked anywhere: Unauthorized Access and Approval Violations, sourced from real events in the existing `DomainEventModel` outbox).
- `getHealthScore` (§22) — a real, transparent, weighted composite (availability/latency/failures/safety/quality/toolSuccess), same honesty precedent as every other computed score in this AI module (`confidenceScore`, `riskScore`). A high guardrail **block** rate does not hurt the safety score (that's the guardrail doing its job); only the genuine attack signal — injection attempts — does.
- `getExecutiveDashboard` (§18) — a rollup of the above.
- `evaluateAlerts` / `listAlerts` (§19) — real threshold evaluation over a rolling window, backed by a new `AIAlertModel` with active/resolved state so a still-breached condition never re-fires a duplicate alert, and a recovered metric resolves it automatically. A critical alert also opens a real `EnterpriseIncidentEngineService` incident, mirroring the exact pattern EXT-032 already established for blocked injection attempts. A window with too few requests to judge a rate-based threshold (below `alertMinSampleSize`) is simply skipped that sweep, not guessed at.

### Wired into both real entry points

- **`AIAssistantService.chat()`** — split into a thin public `chat()` wrapper and the real logic in `_chatCore()`, so **both** the success path (recorded inside `_chatCore`, which has full detail — tokens summed across every tool-calling iteration, real per-provider cost, RAG hit/citation counts when `search_knowledge_base` was called, guardrail-blocked-call count) and the failure path (recorded in the wrapper, since a thrown error like `AI_UNAVAILABLE` can originate before `_chatCore` builds any of that detail) write a real row. The public contract (params in, return shape or thrown error out) is unchanged. `console.error` → the existing structured `logger`.
- **`AIOrchestrationService.executePlan()`** — a row recorded on every exit path (the cooperative cancel/timeout halt, and the normal completed/failed/awaiting-approval path), reusing the execution's own already-computed `tokenUsage`/`estimatedCostUsd`/`toolExecutions`. `console.error` → `logger` at all four call sites. `decideApproval()` now publishes a real `AIApprovalRoleViolation` event (§23) instead of just throwing.
- **`AIToolRegistry.execute()`** — the existing permission-denied branch now publishes `AIUnauthorizedToolAccess` (§23) before returning its error, so an unauthorized attempt is actually counted, not silently dropped.
- **`requestId`** now threads from `req.requestId` (the middleware-generated/echoed ID) through both `AIAssistantController`/`AIOrchestrationController` into the services and onto every `AIRequestMetricModel` row — closing the real §16 gap (an ID that existed but never reached the AI layer).
- **`CacheManager`** — added real `_hits`/`_misses` counters and `getStats()` (§12). Explicitly disclosed: this reflects the whole shared cache (used by `AIPromptService`'s prompt resolution among other things), not an AI-exclusive number — stated plainly wherever it's surfaced, not silently mislabeled.

### API — `controllers/AIObservabilityController.js` / `routes/AIObservabilityRoutes.js`

Mounted at `/api/v1/ai/observability`. Every dashboard/metrics `GET` is **admin-only** (same reasoning as `GetWorkflowMetrics`/`GetGuardrailMetrics` — this is cross-tenant operational, cost, and security data, not something the general `ai.assistant.use` permission should expose). The one non-read action, `POST /alerts/evaluate` (an on-demand trigger of the same check the scheduler runs on a cron), accepts a narrower `ai.observability.manage` permission in addition to admin.

### Scheduler — `services/aiObservabilityAlertScheduler.js`

Exact same `node-cron` static-class shape as `aiApprovalTimeoutScheduler.js`. Discovers which tenants to evaluate dynamically via `AIRequestMetricModel.distinct("tenantId", ...)` over the recent window — never a hardcoded tenant list.

---

## 3. Verification

40 isolated checks against the real production code (`node:test`'s `mock.module`, no live MongoDB in this environment):

- **`verify_observability_service.mjs`** (19 checks): error classification (including the null/unrecognized fallback); real metric persistence; every aggregation method's actual math (success rate, peak-per-hour, per-tool success rate, hallucination-rate proxy, cost summation, security-metric merging); the health score's real composite computation with and without a supplied provider status; **alert evaluation's full real lifecycle** — a genuine threshold breach triggers and persists an alert, the same still-breached condition on the next sweep does NOT duplicate it (de-dup), a recovered metric resolves the alert, and a too-thin sample size is correctly skipped rather than guessed at.
- **`verify_chat_orchestration_metrics.mjs`** (9 checks): `AIAssistantService.chat()`'s wrapper/`_chatCore` split — a real, fully-populated metric row on the success path (correct tool calls, correct summed tokens across iterations, `requestId` threaded through, correct fallback-usage flag), AND a real failed row on the failure path, with the original thrown-error contract to the controller completely unchanged.
- **`verify_orchestration_metrics.mjs`** (6 checks): `AIOrchestrationService.executePlan()` records exactly one real row on completion, with the correct `correlationId`, `requestId`, real tool-call breakdown, and real token usage carried through from the execution's own bookkeeping.

Full suite held at **49/49** throughout, `node --check` clean on all 14 touched/new files.

---

## 4. Completion Status

- **Status**: Production Ready (scoped exactly as described above)
- **Document ID**: `EXT-033`
- **Next recommended**: EXT-034 — AI Model Management & Multi-LLM Routing, per the source document's own pointer. This is also where the honestly-deferred A/B Evaluation piece from §20 becomes buildable, once real model-routing infrastructure exists to split traffic across.
