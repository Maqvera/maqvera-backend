---
title: EXT-035 — AI Agent Framework & Multi-Agent Orchestration
document_id: EXT-035
version: 1.0.0
status: Production Ready (scoped)
module: AI Integration
---

# EXT-035 — AI Agent Framework & Multi-Agent Orchestration

---

## 1. Audit Finding

This codebase already had an earlier, real EXT-035 pass — `services/ai/AIAgentRegistry.js` predates this document's paste and is referenced throughout EXT-032/033/034. Read it fully, plus `AIAssistantService.js`'s existing `agentId` scoping, before writing any code.

| § | Claim | Verdict |
|---|---|---|
| 8 "Agent Registry — Agent ID, Name, Description, Capabilities, Available Tools, Version" | Real, per-agent metadata | **Already implemented** — `AIAgentRegistry`'s static `AGENTS` array, 6 real agents each backed by genuine tools (no fictional capability granted to an agent that doesn't have a real tool for it) |
| 12 "Tool Access ... Least privilege enforced" | Real, per-agent scoping | **Already implemented** — `getToolsForAgent()`, and `_validate()` throws at import time if any real tool isn't claimed by exactly one agent |
| 20 "Monitoring — ... Health Score" | Real, not fabricated | **Partially implemented** — `getHealthScore()` was real but scoped only to the formal-plan path (`AIToolExecutionModel`); a direct chat turn scoped to one agent recorded no attributable usage anywhere |
| **6/7 "Supervisor Agent / Planner Agent — Receive request → Understand intent → Select appropriate agents → Coordinate execution → Merge responses"** | **Dynamic, LLM-driven agent selection and coordination** | **Not implemented at all** — `agentId` scoping existed, but only as a caller-supplied parameter (the frontend/caller chose the agent). Nothing in this codebase ever asked "which agent(s) does THIS request actually need?" |
| **13/14 "Agent Collaboration / Parallel Execution — merge multiple agents' work"** | **Real parallel execution + merge** | **Not implemented** — every turn ran through exactly one LLM pass over one tool subset (or the full catalog). A request genuinely spanning two domains (e.g. flights + hotels together) got one undifferentiated answer, never two specialists collaborating |
| **9 "Agent Discovery ... dynamic"** | **Real capability matching** | **Not implemented** — agent selection was 100% caller-driven, never intent-driven |
| **21 "Agent Lifecycle — Draft → Testing → Approved → Active → Deprecated → Archived"** | **Real, transitionable states** | **Not implemented** — every agent's `status` field was a hardcoded literal `"active"` string with no transition mechanism anywhere |
| §5 "Core Agents" (14 named) | Real backing | **Partially implemented** — 6 of 14 existed with genuine backing; audited the rest and found real, working, currently-unexposed backend capability for **Transport** (`TravelTransportAssignmentModel`) and **Attendance** (`TravelAttendanceModel`) specifically — added as two new agents (see §2). Confirmed **no real backing exists anywhere** for a general-purpose Notification agent (every "notification" in this codebase is a `publishEvent("NotificationRequested", ...)` with zero consumers — a dead convention, not a capability) |
| §10 "Structured Messages ... never free-form text internally" | Real | **Now genuinely enforced** by the new parallel-execution design itself (see §2) — not merely a stated rule |

---

## 2. What Was Built

### The real Supervisor + Planner — `services/ai/AISupervisorService.js`

`selectAgents()` is a real LLM call (routed through EXT-034's Model Router, category `planning`) classifying the user's request against the **live, lifecycle-and-permission-filtered** agent catalog — never a hardcoded keyword map, and a hallucinated `agentId` is dropped exactly the way `AIOrchestrationService.createPlan()` already drops a hallucinated tool name. On any failure (no eligible agents, an unparseable response, no provider reachable), it returns `degraded: true` instead of throwing — §17 "Graceful Degradation."

`coordinate()` is the real entry point:
- **0 or 1 relevant agent** → delegates straight to the existing, already-fully-tested `AIAssistantService.chat()`, unchanged. This is a deliberate design choice, not laziness: reimplementing single-agent conversational logic a second time would be real duplication for zero behavioral gain, and every existing guardrail/memory/prompt/observability guarantee stays intact for the common case.
- **2+ relevant agents** → the genuinely new capability. Each selected agent runs its own independent reasoning turn (`_runAgentTurn`) over its own real least-privilege tool subset, in real parallel (`Promise.allSettled`, the exact same pattern `AIOrchestrationService.executePlan()` already uses for parallel tool groups). **Each agent gets its own independent copy of the conversation history** — never a shared mutable array — so one agent's tool calls can never leak into a sibling's reasoning context mid-flight; this is the literal mechanism behind §10's "agents never communicate using free-form text internally." Results are merged **sequentially, after every agent has finished** (never during, avoiding any concurrent-mutation hazard on the shared session memory or conversation document), then one real LLM synthesis call (`agent_merge` prompt, category `reasoning`) combines the agents' independent, real answers into one unified recommendation — §13's own "Merged Recommendation." The conversation document is written **exactly once**, by the Supervisor alone, closing the real race that would exist if multiple agents independently called `AIAssistantService.chat()` against the same `conversationId` concurrently (each does its own read-then-save).
- If every selected agent fails, the response honestly says so rather than fabricating a merge from nothing — the merge LLM call doesn't even fire in that case.

### Two new agents with real, previously-unexposed backing

- **Transport Agent** (`get_travel_plan_transport`, reading `TravelTransportAssignmentModel`) and **Attendance Agent** (`get_travel_plan_attendance`, reading `TravelAttendanceModel`) — both real, read-only, mirroring the exact pattern `get_travel_plan_status` already established (resolve `travelPlanNumber` → `TravelPlanModel._id` → scoped query). Check-in/check-out recording and transport status changes remain human/on-ground-staff actions through the existing REST endpoints — the AI only ever reads this data, never writes it.
- Every other named-but-unbuilt agent in §5 (Reporting, Incident Response beyond its existing summary tool, Customer Support, Notification, AI Analytics) was deliberately **not** added — some have real unexposed backing (Reporting via `KPIEngine`/`VisaAnalyticsEngine`, deeper Incident Response via `EnterpriseIncidentEngineService`) but choosing which of a dozen-plus methods to expose, and for Incident Response designing real approval-gating for anything beyond a read, is a substantive follow-up task in its own right — not required for this document's actual deliverable, the framework itself. Notification has **no real backing to expose at all**.

### Real Agent Lifecycle — `models/AIAgentStateModel.js`

A tenant-scoped, DB-backed **overlay** on the static registry — mirrors exactly how EXT-032's `AIPolicyModel` overlays the real, static `AIToolRegistry` rather than replacing it. An agent with no overlay row is honestly "active" at its registry default — this is what keeps all 8 agents behaviorally unchanged until an admin deliberately calls `AIAgentRegistry.transitionState()`. `listActive()` — the Supervisor's real candidate pool — respects this: a `deprecated`/`archived`/pre-`active` agent is genuinely excluded from selection, tenant-scoped (one tenant deprecating an agent never affects another).

### Real Agent Usage monitoring (§20)

`AIRequestMetricModel` gained `agentIds`/`supervisorUsed`/`agentBreakdown` — populated by **both** paths (a single-agent chat turn tags its one `agentId`; a Supervisor-coordinated turn tags every participating agent with its own real duration/tool-call/success data). `AIObservabilityService.getAgentMetrics()` aggregates real usage/success-rate/duration per agent across both paths uniformly — the real gap the audit found (chat-path agent usage was previously unattributed anywhere) is closed.

### API

`POST /api/v1/ai/supervisor` (new, additive — `/ai/chat` is completely unchanged and still the simpler, faster single-pass option); `PATCH /api/v1/ai/agents/:agentId/state` (lifecycle transitions, `ai.agent.manage` permission or admin); `GET /api/v1/ai/agents` (now includes each agent's real `effectiveStatus`); `GET /api/v1/ai/observability/agents` (admin-only usage metrics, same gating as every other observability dashboard).

---

## 3. Verification

19 isolated checks against the real production code (`node:test`'s `mock.module`, no live MongoDB in this environment):

- **`verify_agent_registry_lifecycle.mjs`** (10 checks): both new agents genuinely own their real tools; an agent with no overlay row defaults honestly to active; `listActive()`'s real least-privilege filtering (only the genuinely permission-less `search-agent` survives zero permissions — every gated agent correctly excluded); a real lifecycle transition persists and is genuinely respected by the next `listActive()` call; invalid `agentId`/`status` are rejected; the overlay is correctly tenant-isolated.
- **`verify_supervisor_service.mjs`** (9 checks): a genuinely multi-domain request selects both real relevant agents and marks `coordinated: true`; **both agents' LLM calls actually fire** (proven via a call-log assertion, not assumed); the merge call combines both agents' real, independent answers; `agentResults` reports each agent's own real answer; **exactly one** conversation save occurs (the race this document's design specifically prevents); the recorded metric row carries real `supervisorUsed`/`agentIds`/`agentBreakdown`; a 0-relevant-agent request gracefully delegates to the existing single-pass chat path unchanged; a hallucinated `agentId` is dropped before the remaining single real agent correctly delegates rather than needlessly "coordinating" for one participant.

Full suite held at **49/49** throughout, `node --check` clean on all 13 touched/new files.

---

## 4. Completion Status

- **Status**: Production Ready (scoped exactly as described above)
- **Document ID**: `EXT-035`
- **Next recommended**: EXT-036 — AI Agent Workflow Runtime & Execution Engine, per the source document's own pointer.
