---
title: EXT-026 — AI Tool Orchestration for Amadeus Integration (Audit + Two Real Gaps Closed)
document_id: EXT-026
version: 1.0.0
status: Production Ready
module: AI Integration
provider: Amadeus
---

# EXT-026 — AI Tool Orchestration

---

## 1. Audit Finding

Like EXT-025, most of this document describes infrastructure that **already exists**, built to a mature standard before this document was pasted:

| § | Claim | Verdict |
|---|---|---|
| 2/3 | Tool-based architecture, AI never builds HTTP requests directly | **Already implemented** — `AIToolRegistry` is the only path any AI tool takes to reach a service; no tool handler ever imports `gdsHttpClient`/`AmadeusAdapter` directly |
| 4/5 | Named tools with input/output DTOs | **Already implemented**, different naming convention (`flight_search` not `flight.search`) — not renamed; churn with no functional value |
| 6/7 | Multi-step decision flow, tool chaining | **Already implemented** — `AIAssistantService.chat()`'s tool-calling loop (`maxToolIterations`) |
| 8 | Confirmation required for book/cancel/modify/refund | **Already implemented and verified throughout this entire session** — every write-capable tool (`propose_flight_booking`, `propose_hotel_booking`, `propose_hotel_cancellation`) creates an `AIApprovalRequestModel` row and never executes the real action itself |
| 9 | Context Memory (selected flight/hotel, preferences, expiry) | **Not implemented** — and correctly so: this is explicitly the user's own **next** document (EXT-027, "AI Agent Memory & Conversation Context"). Not built prematurely here |
| 10 | Graceful error recovery, no raw provider errors exposed | **Already implemented** — `AIToolRegistry.execute()` catches every handler error into `{error: message}`, never a raw stack/provider payload |
| 11 | JWT/tenant/RBAC before tool execution | **Already implemented** |
| 12 | Prompt injection protection | **Already implemented** (`AIAssistantService.detectPromptInjection`, config-driven pattern list) |
| **13** | **Rate limiting — user/tenant/global limits per tool** | **Not implemented** — only a route-level `express-rate-limit` existed on the whole `/ai/*` group; nothing limited individual tool invocations. **Built this turn.** |
| 14 | Audit logging (correlation ID, user, tenant, tool, timing) | **Already implemented** — `AuditLogModel` + full `AIConversationModel.toolExecutions` trail (per-call `durationMs` already recorded) |
| **15** | **Response rules — always explain price/stops/refundability/baggage/travel time/arrival time** | **Partially implemented** — the system prompt already forbids inventing data, but never explicitly required covering these specific fields. **Enhanced this turn.** |
| 17 | Future provider support | Honest already in the doc — Sabre/Travelport/Duffel/Mystifly listed without checkmarks |

---

## 2. What Was Actually Built

### §13 Rate Limiting — `services/ai/AIToolRateLimiter.js`

Real, in-process fixed-window counters at three independent scopes, checked in order before every tool handler runs: **user** → **tenant** → **global**, each per-tool (a limit on `propose_flight_booking` doesn't affect `flight_search`). Same honesty scope as `GdsIntegrationService`'s own `CircuitBreaker` — real and enforced for this running instance, not a claim of a distributed guarantee (a future Redis-backed version could swap in without changing the call site).

**Deliberately not duplicated**: a "Provider Limit" — `GdsIntegrationService`'s circuit breaker and `AmadeusMetricsService.rateLimitedCount` already are the real provider-side signal; this layer only adds the AI-initiated User/Tenant/Global limits on top, not a second copy of the same thing.

Wired into `AIToolRegistry.execute()` — checked after permission validation (no point spending a rate-limit slot on a request that was going to be denied anyway) and before the handler runs, publishing `AIToolRateLimited` when exceeded.

### §15 Response Rules — system prompt enhancement

Added an explicit rule to `AIAssistantService`'s `SYSTEM_PROMPT_TEMPLATE`: when presenting a flight/hotel option, state price, stops/refundability, baggage (when present), travel time, and arrival time — and say plainly when a field wasn't returned by the tool, rather than silently omitting it or guessing.

---

## 3. Verification

11 isolated checks: config defaults, real per-user exhaustion at exactly the configured limit, real per-user/per-tenant/per-tool isolation (a different user/tool is genuinely unaffected by another's limit — not a shared bucket), tenant-level cap holding even across many distinct users, and confirmation that `AIToolRegistry.execute()` itself — not just the standalone limiter class — enforces this. Full suite 49/49 held throughout.

---

## 4. Completion Status

- **Status**: Production Ready
- **Document ID**: `EXT-026`
- **Next Document**: `EXT-027 — AI Agent Memory & Conversation Context`
