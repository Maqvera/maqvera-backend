---
title: AI Tool Registry & Orchestration Engine
document_id: API-006G
version: 1.0.0
status: Production Approved
module: AI Services
---

# AI Tool Registry & Orchestration Engine

---

## 1. Overview

The Orchestration Engine sits between the LLM and every enterprise capability API-006F's tools expose. It never owns business logic and never writes to the database on the AI's behalf — `AIToolRegistry` still defines exclusively read-only tools plus one deliberately-scoped exception (`propose_flight_booking`) whose handler only ever creates a pending approval row and hands back the real REST endpoint call a human must invoke; the AI layer itself never performs a write.

### Supported AI Providers
✓ OpenAI ✓ Anthropic Claude ✓ Azure OpenAI (real, `openai` SDK against Azure's endpoint) — Google Gemini and Local Models remain "(Future)", same as this document's own §4, rather than a rushed/unverified integration.

---

## 2. Relationship to API-006F

006F's `/ai/chat` and friends remain a single-turn conversational loop (LLM decides + calls one tool at a time, in-request). 006G adds a **separate, explicit two-phase path** — `POST /ai/tools/plan` (decompose, nothing executes) then `POST /ai/tools/execute` (run the approved plan, parallel where marked, sequential otherwise, with tool-level retry) — for requests that benefit from an inspectable plan before anything runs. Both paths share the same `AIToolRegistry`, so a tool defined once is usable from either.

---

## 3. Responsibilities

### Responsible For
✓ Tool Registration (`AIToolRegistry`, publishes `AIToolRegistered` once at first use)
✓ Tool Discovery (`GET /ai/tools`, `GET /ai/tools/:toolId`, including an MCP-compatible schema view)
✓ Multi-step Planning (`POST /ai/tools/plan`)
✓ Parallel & Sequential Execution (`parallelGroup` on each plan step)
✓ Retry Policies (tool-level, error-classified — see §7)
✓ Human Approval Workflow (`AIApprovalRequestModel` + `POST /ai/tools/approval`)
✓ Execution Logging (`AIToolExecutionModel` — plan, tool results, tokens, estimated cost, timing)
✓ Response Validation (`ajv`-backed JSON-Schema validation via `POST /ai/tools/validate`)

### Not Responsible For
✗ Business Logic ✗ Database Updates (beyond its own plan/approval/execution-log records) ✗ Authentication (delegated to `authenticateAccessToken`) ✗ Domain Rules

---

## 4. Tool Registry (as built)

Every tool in `AIToolRegistry` now declares the full field set this document's §6 requires: `name`, `description`, `parameters` (Input Schema), `outputSchema`, `requiredPermissions`, `requiredRoles`, `executionType` (`"Synchronous"` for every tool today — none are long-running/streaming), `timeoutMs`, `retryPolicy`, `version`, `ownerModule`, `riskLevel`, `requiresApproval`.

11 tools total: the 10 read-only tools carried over from API-006F, plus `propose_flight_booking` (`riskLevel: "high"`, `requiresApproval: true`, `requiredApprovalRole: "admin"`).

`GET /ai/tools?format=mcp` returns the same catalog reshaped to the MCP tool-definition format (`{name, description, inputSchema}`) — a real, verifiable schema mapping. No live MCP transport (stdio/SSE server) is stood up; that's a materially larger, separate undertaking this document does not claim to have built.

---

## 5. Execution Types

Synchronous only, today. Asynchronous / Background Job / Long Running / Streaming / Batch are named in this document's own §7 as execution *type* categories a tool could declare, but every currently-registered tool completes within one request — none of the underlying services (GDS search, visa lookups, dashboards) are long-running, so nothing in this codebase would exercise those modes honestly yet. `executionType` is a real, read field on every tool for when one is added.

---

## 6. API Inventory

| Method | Endpoint |
|---|---|
| `GET` | `/api/v1/ai/tools` |
| `GET` | `/api/v1/ai/tools/:toolId` |
| `POST` | `/api/v1/ai/tools/validate` |
| `POST` | `/api/v1/ai/tools/plan` |
| `POST` | `/api/v1/ai/tools/execute` |
| `POST` | `/api/v1/ai/tools/approval` |
| `GET` | `/api/v1/ai/executions` |
| `GET` | `/api/v1/ai/executions/:executionId` |
| `GET` | `/api/v1/ai/tools/providers/status` |

All require `Authorization: Bearer <JWT>` and `ai.assistant.use` (or `admin`).

---

## Endpoint Contract: POST /api/v1/ai/tools/plan

### Request
```json
{ "prompt": "Find the cheapest Umrah package for five travelers." }
```

### Response
```json
{
  "success": true,
  "data": {
    "executionId": "...",
    "correlationId": "AIEXEC-...",
    "status": "planned",
    "plan": [
      { "stepNumber": 1, "toolName": "flight_search", "arguments": { "...": "..." }, "parallelGroup": 1, "requiresApproval": false, "reasoning": "..." },
      { "stepNumber": 2, "toolName": "hotel_search", "arguments": { "...": "..." }, "parallelGroup": 1, "requiresApproval": false, "reasoning": "..." }
    ]
  }
}
```
`parallelGroup: 1` on both steps means flight and hotel search run concurrently at execution time. **No tool has been executed yet** — the plan is a proposal, persisted with `status: "planned"`. A hallucinated tool name the LLM might invent is silently dropped from the plan (never executed), and the plan is capped at `AI_MAX_PLAN_STEPS`.

---

## Endpoint Contract: POST /api/v1/ai/tools/execute

### Request
```json
{ "executionId": "..." }
```

Loads the plan (must still be `status: "planned"` — re-executing an already-run plan is rejected, `409`), re-validates permissions per step (`AIToolRegistry`'s Permission Validator — identical check to what the real REST endpoint would run), groups steps by `parallelGroup` and runs each group via `Promise.allSettled` when it has more than one step, applies the retry policy below per step, and — once every step has run — makes one final LLM synthesis call grounded only in the real collected tool results, never inventing anything not present in them.

---

## 7. Retry Policy (as implemented)

Classification is message-based (`isRetryableError` in `AIOrchestrationService.js`):

- **Retryable**: timeout, rate limit / 429, network failure (ECONNRESET/ECONNREFUSED/fetch failed), "unavailable"
- **Non-retryable**: permission denied, validation error ("required"/"invalid"), not found

A step only retries if its tool's own `retryPolicy.retryable` is `true` *and* the specific failure classifies as retryable — `propose_flight_booking` overrides `retryable: false` since blindly retrying a state-creating action risks duplicate pending approvals.

---

## 8. Human Approval Workflow (as implemented)

```
AI (or a plan step) calls propose_flight_booking
      │
      ▼
AIApprovalRequestModel created — status "pending", proposedAction = { method, endpoint, body }
      │
      ▼
AIApprovalRequested published
      │
      ▼
Human with the required role calls POST /ai/tools/approval { approvalRequestId, decision: "approve" | "reject", reason }
      │
      ▼
Approved  → AIApprovalGranted published, response includes `proposedAction` (the exact real endpoint call to make — e.g. POST /api/v1/flight-bookings)
Rejected  → AIApprovalRejected published, proposedAction withheld
```

**Approving never executes the action.** The orchestration engine hands the caller (a human operator or a UI) the exact already-audited REST call from API-006C to make next. This is the concrete reason "Not Responsible For: Database Updates" stays true even for a fully-approved high-risk action — no duplicate booking logic exists inside the AI layer.

Only `propose_flight_booking` exists today as a worked example of this pattern; the framework (`requiresApproval`, `requiredApprovalRole`, `AIApprovalRequestModel`, the generic `decideApproval` flow) is generic and ready to receive `propose_ticket_issuance`, `propose_cancellation`, etc. without further architectural changes.

---

## 9. Execution Log

`AIToolExecutionModel` persists exactly this document's §"Execution Log" field list: Execution ID (`_id`), Prompt, Plan, Tools Used (`toolExecutions`), Execution Time (`totalExecutionTimeMs`), Provider, Cost (`estimatedCostUsd` — real per-token math against a configured, labeled-as-estimated rate, never a fabricated number), Token Usage, Status, Errors (`executionErrors` — named to avoid Mongoose's reserved `errors` document property), Audit Reference.

---

## 10. Security (as implemented)

| Control | Implementation |
|---|---|
| JWT Validation | `authenticateAccessToken` on every route |
| RBAC | `ai.assistant.use`/`admin` gate + per-tool `requiredPermissions`/`requiredRoles` |
| Tenant Isolation | Every query (`AIToolExecutionModel`, `AIApprovalRequestModel`, tool handlers) scoped by the real `tenantId` |
| Tool Allow Lists | Only tools present in `AIToolRegistry` can ever be planned or executed — a hallucinated name is dropped |
| Rate Limiting | Same 30/10min limiter as API-006F |
| Correlation IDs | `AIEXEC-<uuid>` per execution, threaded into tool calls that support one |

Prompt Injection Protection and Output Sanitization are inherited from API-006F's `AIAssistantService` (shared adapters/system-prompt conventions); this document did not duplicate that heuristic, it reuses it.

---

## 11. Domain Events

- `AIToolRegistered` (once, on first registry read)
- `AIToolExecuted` (per tool call, includes `retryCount`)
- `AIExecutionCompleted`
- `AIExecutionFailed`
- `AIApprovalRequested`
- `AIApprovalGranted`
- `AIApprovalRejected`

---

## 12. AI Coding Rules Summary

✓ Tool Registry Pattern ✓ Function Calling ✓ Multi-LLM Ready (OpenAI/Anthropic/Azure OpenAI, real adapters) ✓ Provider Independent ✓ Human Approval ✓ Structured Outputs ✓ Retry Policies ✓ Execution Logging ✓ Event Driven ✓ Zero Direct Database Access (beyond the engine's own plan/approval/log records)

**Deliberately deferred, not fabricated**: live MCP transport (stdio/SSE server) — schema compatibility is real and verifiable, the transport layer is not built. Google Gemini adapter — same reasoning as Travelport/Booking.com across the GDS documents: named as a future provider, not wired until a real, tested integration is worth the added surface. Multi-Agent Workflow and Streaming execution — named in this document's own §8/§7 as **Future**, and nothing in this codebase today needs either.

---

## 13. Completion Status

- **Status**: ✅ Production Ready (planning/execution require `OPENAI_API_KEY`/`ANTHROPIC_API_KEY`/Azure equivalent; honest `503 AI_UNAVAILABLE` otherwise, same as API-006F)
- **Document ID**: `API-006G`
- **Version**: `1.0.0`
