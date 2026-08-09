---
title: EXT-028 — AI Multi-Step Planning & Execution Engine
document_id: EXT-028
version: 1.0.0
status: Production Ready
module: AI Integration
---

# EXT-028 — AI Multi-Step Planning & Execution Engine

---

## 1. Audit Finding

`AIOrchestrationService.createPlan()`/`executePlan()` already implement the bulk of this document's architecture (built across the EXT-036 chunks earlier this session): goal decomposition, parallel execution, approval checkpoints, per-tool retry, crash-recovery checkpointing, and idempotency. Five real gaps remained:

| § | Claim | Verdict |
|---|---|---|
| 1–6, 9, 12, 13, 17–19 | Goal→plan→execute pipeline, approval checkpoints, "never abort the whole workflow on one failure," parallel execution, tool allow-list, security/audit | Already implemented |
| **7** | **Task States — Pending/Ready/Running/Waiting Approval/Completed/Failed/Skipped/Cancelled/Retry Scheduled** | **Partially implemented** — only a binary `succeeded`/`error`; no "skipped" or "cancelled" state existed anywhere |
| **8** | **Dependency Rules — "Tasks execute only after dependencies complete successfully"** | **Not implemented** — a later parallel group ran unconditionally regardless of whether an earlier group's steps succeeded. A plan step depending on a failed prior step (e.g. proposing a booking for an offer a failed search never returned) would still be attempted |
| **10/14** | **Execution Monitoring / Progress Reporting** | **Not implemented** — no computed completed/failed/pending breakdown or percentage was ever exposed |
| **15** | **Cancellation** | **Not implemented at all** — no cancel method, no endpoint, no state for it |
| **16** | **Memory Integration — "Planner reads Session Memory... No repeated information requests"** | **Not implemented for this engine** — EXT-027's `AIContextMemory` was wired into the conversational `AIAssistantService.chat()` path only; the formal `createPlan()`/`executePlan()` planner never read or wrote it, so the two "memories" were disconnected |

Also confirmed honest: §17's `transport.search`/`transport.book` have no real service anywhere in this codebase (an already-flagged gap from earlier EXT audits) — not fabricated here either.

---

## 2. What Was Built

### Dependency enforcement (§8) + richer task states (§7)

Plan steps gained a `dependsOn: [stepNumber]` field, populated by the planning LLM (the prompt now explicitly asks for it, with a worked example matching the doc's own "Book Flight requires Verified Flight Price requires Selected Flight" chain) and enforced by the engine: before a step runs, `executePlan()` checks whether every declared dependency's `toolExecutions` entry has `succeeded: true`. If not, the step is never attempted — no tool call, no cost — and is recorded `state: "skipped"` with the unmet dependency named in its error message. This cascades naturally: a step depending on an already-skipped step fails the same check, since "skipped" isn't "succeeded". An **independent** step (no `dependsOn`) still runs regardless of an earlier failure — the existing "never abort the whole workflow" behavior is preserved, just made selective rather than blanket.

`toolExecutions[]` gained a `state` field (`completed`/`failed`/`skipped`/`cancelled`) alongside the existing `succeeded` boolean (kept as-is — the resume/idempotency logic from EXT-036 still reads it unchanged). "Pending"/"ready"/"running" have no separate persisted representation: a step with no `toolExecutions` entry yet **is** "pending" — that's the honest state, since this architecture has no live visibility into which specific step is mid-flight from outside the request running it. "Retry Scheduled" likewise isn't modeled separately: retries happen synchronously inside a step's own attempt loop, never deferred to a later scheduled run — inventing a persisted state for that would misrepresent how retries actually work here.

`createPlan()`'s own step-filtering (dropping a hallucinated tool name, truncating to `maxPlanSteps`) renumbers surviving steps — `dependsOn` references are remapped through the same original→kept mapping, and a dependency on a dropped step, or a self/forward reference, is silently omitted rather than persisted as something the engine could stall on.

### Cancellation (§15)

`AIOrchestrationService.cancelExecution()` — a `"planned"`/`"awaiting_approval"` execution (nothing in flight) cancels immediately; an `"executing"` one is cancelled **cooperatively**: a `cancellationRequested` flag is set, and the in-flight `executePlan()` call checks it at its next group boundary (the same checkpoint the crash-recovery work already added) rather than forcibly aborting an in-progress tool call — this codebase's tools don't wire an `AbortController` through, so that's the honest, achievable scope, stated plainly rather than claimed as instant. On observing the flag: every plan step that never got a `toolExecutions` entry is recorded `state: "cancelled"`; anything already completed/failed/skipped is left exactly as-is; no synthesis pass runs (a partial snapshot, not a fabricated final answer); `status` becomes `"cancelled"`. New route: `POST /api/v1/ai/executions/:executionId/cancel`.

### Progress reporting (§10/§14)

`AIOrchestrationService.computeProgress(execution)` — derived purely from `plan` + `toolExecutions` (never a separately-tracked counter that could drift): `totalSteps`, `completedSteps`, `failedSteps`, `skippedSteps`, `cancelledSteps`, `pendingSteps`, `percentComplete`, `awaitingApproval`. Deliberately has **no** "running" count — this architecture can't know which specific step is mid-flight from outside the request executing it, and reporting one would be a guess. Included automatically in `GET /api/v1/ai/executions/:executionId`.

### Memory integration (§16)

`createPlan()` now accepts an optional `conversationId`; when given, it loads that conversation's EXT-027 session memory (same lazy-expiry check `AIAssistantService.chat()` uses) and injects it into the planning prompt exactly like the conversational path does — a plan triggered against a conversation that already searched flights doesn't re-ask for origin/destination/dates. `executePlan()` mirrors this: for a plan linked to a conversation, each successful step's real tool arguments/result update the same `AIContextMemory` structure `chat()` reads and writes, so the two paths share one continuous session memory instead of two disconnected ones. The created execution also now actually sets the `conversationId` field the schema already had (previously always `null`).

---

## 3. Verification

23 isolated checks against the real production code (`node:test`'s `mock.module`, no live MongoDB in this environment):

- **Dependency/cancellation/progress** (15 checks): a step depending on a failed step is never invoked and recorded `skipped`; an independent sibling step still runs; cascading skip through two levels; `computeProgress` counts across a completed/failed/skipped mix; a cancellation flag set mid-flight by a concurrent request stops the loop at the next group boundary, keeps the already-completed step's real result, marks the rest `cancelled`, skips synthesis; `cancelExecution()`'s three branches (immediate cancel, cooperative flag, reject-if-terminal).
- **`createPlan()` remapping + memory** (8 checks): a hallucinated tool is dropped and surviving steps' `dependsOn` correctly remapped (including a dependency purely on the dropped step vanishing rather than dangling); a self/forward reference is dropped; the formal planner's own captured system prompt is proven to contain a conversation's remembered flight context; a plan's real execution result flows back into that same conversation's memory.

Full suite held at **49/49**, `node --check` clean on every touched file.

---

## 4. Completion Status

- **Status**: Production Ready
- **Document ID**: `EXT-028`
- **Next recommended**: EXT-029 — AI Workflow Engine & Long Running Jobs (per the source document's own pointer) — largely already covered by this session's EXT-036 crash-recovery/idempotency work; worth a short audit pass before assuming so.
