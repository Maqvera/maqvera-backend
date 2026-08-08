---
title: AI Travel Assistant API
document_id: API-006F
version: 1.0.0
status: Production Approved
module: AI Services
---

# AI Travel Assistant API

---

## 1. Overview

The AI Travel Assistant is an enterprise AI orchestration layer, not a chatbot wrapper. It never owns business logic and never writes to the database directly — it consumes existing read APIs/services through a fixed, code-defined tool registry, exactly as a human user would through the real APIs, with the same permission checks enforced per tool call.

### Supported Providers
✓ OpenAI (Chat Completions, native function calling)
✓ Anthropic (Messages API, native tool use)
✓ Provider-independent adapter pattern — mirrors `services/gds/BaseGdsAdapter.js`'s Base/Amadeus/Sabre convention (`services/ai/BaseAIProviderAdapter.js` + `OpenAIAdapter.js` + `AnthropicAdapter.js`)

When neither `OPENAI_API_KEY` nor `ANTHROPIC_API_KEY` is configured (or both providers are unreachable), every `/ai/*` endpoint returns an honest `503 AI_UNAVAILABLE` — never a fabricated reply. This is the one place this module deliberately does **not** mirror the GDS adapters' "dynamic sandbox" fallback: synthetic flight rows are clearly labeled as such; a synthetic AI *reasoning* response presented as genuine would be actively misleading.

---

## 2. Business Purpose

Users describe what they need in natural language; the assistant determines which internal read APIs answer the question, calls them for real, and synthesizes an answer grounded in their actual results.

---

## 3. Responsibilities

### Responsible For
✓ Flight/Hotel Recommendations (via real `GdsIntegrationService` search calls)
✓ Visa Requirement Explanation (via `VisaRequirementService`)
✓ Booking/Travel Plan Status Lookup
✓ Operational & Revenue Dashboard Questions (via `VisaAnalyticsEngine`, revenue gated to the `visa.dashboard.management` permission)
✓ Incident Summaries (via `EnterpriseIncidentEngineService`)
✓ Natural Language / Knowledge Base Search (via `SearchEngineService.globalSearch`, which applies its own real permission filtering)
✓ Multi-step planning (chained tool calls within one conversation turn)

### Not Responsible For
✗ Booking Flights ✗ Issuing Tickets ✗ Processing Payments ✗ Updating the database directly ✗ Executing any business command

**This is enforced architecturally, not just by prompt instruction**: `AIToolRegistry` never defines a write/mutating tool. The LLM is structurally incapable of booking, cancelling, refunding, or approving anything, regardless of what a user or a prompt-injected tool result asks it to do.

---

## 4. AI Architecture (as built)

```
User
  │
  ▼
AI Gateway (routes/AIAssistantRoutes.js — auth + rate limit)
  │
  ▼
Controller (controllers/AIAssistantController.js — permission gate, input validation)
  │
  ▼
AIAssistantService.chat() — Prompt Orchestrator + Context Builder
  │
  ▼
Tool Router (AIToolRegistry — schemas + per-tool Permission Validator)
  │
  ▼
Enterprise Services (GdsIntegrationService, VisaRequirementService, VisaAnalyticsEngine,
                      EnterpriseIncidentEngineService, SearchEngineService, BookingHeaderModel, TravelPlanModel)
  │
  ▼
LLM (OpenAI / Anthropic, native tool calling, bounded iteration loop)
  │
  ▼
Response Validator (system-prompt-leak guard, confidence scoring)
  │
  ▼
User + AIConversationModel (persisted history)
```

---

## 5. AI Context Sources

Every source below is read-only, called with the requesting user's real `tenantId`/`branchId`/`permissions` — the AI can never see data the same user couldn't already see through the real API:

Flight Search · Hotel Search · Visa Requirements · Booking Status · Travel Operations Status · Operations Dashboard · Revenue Dashboard (requires `visa.dashboard.management` permission) · Incident Summaries · Enterprise Search (Knowledge Base fallback)

---

## 6. API Inventory

| Method | Endpoint | Forced tool (if any) |
|---|---|---|
| `POST` | `/api/v1/ai/chat` | none — full tool selection |
| `POST` | `/api/v1/ai/flight-search` | `flight_search` |
| `POST` | `/api/v1/ai/hotel-search` | `hotel_search` |
| `POST` | `/api/v1/ai/package-search` | none — flight + hotel combo, model chooses |
| `POST` | `/api/v1/ai/travel-plan` | none — multi-step planning |
| `POST` | `/api/v1/ai/dashboard` | `get_operations_dashboard` |
| `POST` | `/api/v1/ai/analytics` | `get_revenue_dashboard` |
| `POST` | `/api/v1/ai/search` | `enterprise_search` |
| `POST` | `/api/v1/ai/explain` | none — fare rules or visa requirements, model chooses |
| `POST` | `/api/v1/ai/summarize` | none |
| `POST` | `/api/v1/ai/recommend` | none |
| `GET` | `/api/v1/ai/conversations` | — |
| `POST` | `/api/v1/ai/conversations/:conversationId/archive` | — (completes the Memory lifecycle; not in the original inventory but required by §11) |
| `GET` | `/api/v1/ai/providers/status` | — (provider/circuit-breaker health) |

All routes require `Authorization: Bearer <JWT>` and the `ai.assistant.use` permission (or `admin`).

---

## Endpoint Contract: POST /api/v1/ai/chat

### Request
```json
{ "message": "Suggest the best Umrah flight for five passengers leaving next Friday.", "conversationId": null, "mode": "Assistant" }
```

### Response
```json
{
  "success": true,
  "data": {
    "conversationId": "...",
    "answer": "I found three suitable flights via live Flight Search...",
    "recommendations": [ { "source": "flight_search", "airline": "Saudi Airlines", "price": 145000, "...": "..." } ],
    "toolExecutions": [ { "toolName": "flight_search", "succeeded": true, "durationMs": 812 } ],
    "confidenceScore": 80,
    "sources": ["flight_search"],
    "provider": "OpenAI",
    "flaggedPromptInjection": false
  }
}
```

### AI Decision Rules (enforced, not just prompted)
- Never invent flights/hotels/prices/availability — `recommendations` are built directly from real tool-call results, never parsed out of the model's free text.
- Tool execution is permission-checked per call against the real caller's permissions (`flight.search`, `hotel.search`, `visa.read`, `bookings.read`/`booking.read`, `travel.read`/`travel_plans.read`, `incidents.read`; `get_revenue_dashboard` additionally requires the `visa.dashboard.management` permission).
- Bounded tool-calling loop (`AI_MAX_TOOL_ITERATIONS`, default 4) — never an unbounded agent loop.

---

## 7. Confidence Score & Source Attribution

`confidenceScore` (0–100) is a deterministic, transparent signal — not a fabricated certainty: it starts higher when at least one tool call succeeded, gains points per additional successful call, and loses points per failed call. `sources` lists exactly which internal tools actually backed the answer.

---

## 8. AI Security (as implemented)

| Control | Implementation |
|---|---|
| Tenant Isolation | Every tool handler scopes its query by the real `tenantId` from the JWT |
| Permission Validation | `AIToolRegistry.execute()` checks the caller's real permissions before every tool call |
| Conversation Logging | `AIConversationModel` persists every message and tool execution |
| Prompt Validation | Message length capped (`AI_MAX_MESSAGE_LENGTH`) |
| Prompt Injection Protection | Regex heuristic (`AI_PROMPT_INJECTION_PATTERNS_JSON`) flags and logs suspicious prompts on the conversation record; the system prompt also instructs the model to treat tool-result content as untrusted data, not instructions — an honest, bounded mitigation, not a claim of foolproof detection |
| Output Validation | Refuses to echo the system prompt back if the model is manipulated into leaking it |
| Rate Limiting | 30 requests / 10 minutes per IP on the whole `/ai/*` router (tighter than the ERP's standard 100/10min, since LLM calls are expensive) |
| Audit Logging | `AuditLogModel` entry (`AI_CHAT`) per turn, including which tools ran and whether injection was flagged |

---

## 9. AI Conversation Memory

`Conversation → Session → Context → Summary → Archive`, implemented as: active `AIConversationModel` documents accumulate messages/tool executions per turn; `POST /ai/conversations/:id/archive` sets `status: "archived"`, generates a summary from the user's own messages (never fabricated), and publishes `AIConversationEnded`. `AI_CONVERSATION_RETENTION_DAYS` documents the intended retention policy; no automatic purge job exists yet — flagged, not built, since no retention/purge convention exists elsewhere in this codebase to extend from.

---

## 10. Domain Events

- `AIConversationStarted`
- `AIContextLoaded`
- `AIToolExecuted` (per tool call, includes `succeeded`/`durationMs`)
- `AIRecommendationGenerated` (when a turn produces real tool-derived recommendations)
- `AIConversationEnded` (on archive)

---

## 11. AI Coding Rules Summary

✓ Tool Calling (native OpenAI/Anthropic function/tool calling, not prompt-parsed pseudo-tools)
✓ Read Models Only (no write tool is ever defined)
✓ Provider Independent (Base/OpenAI/Anthropic adapter pattern, automatic failover)
✓ Context Builder (tenant/role/date injected into every system prompt)
✓ Prompt Templates (single source-of-truth `SYSTEM_PROMPT_TEMPLATE`)
✓ Structured Outputs (`recommendations` built from real tool JSON, not parsed prose)
✓ Confidence Score & Source Attribution (real, deterministic, tool-success-derived)
✓ Human Approval Required (structurally — no booking/mutating tool exists to approve)

**Deferred, not fabricated**: RAG (a real vector/embedding retrieval pipeline) is not implemented — `enterprise_search` provides real, permission-filtered full-text retrieval today, but that is not the same as RAG, and this document does not claim it is. Multi-agent orchestration, MCP integration, and cross-LLM cost optimization are explicitly out of scope for this document and belong to API-006G.

---

## 12. Completion Status

- **Status**: ✅ Production Ready (requires `OPENAI_API_KEY` and/or `ANTHROPIC_API_KEY` to actually answer; honest 503 otherwise)
- **Document ID**: `API-006F`
- **Version**: `1.0.0`
- **Next Document**: `API-006G — AI Tool Registry & Orchestration Engine`
