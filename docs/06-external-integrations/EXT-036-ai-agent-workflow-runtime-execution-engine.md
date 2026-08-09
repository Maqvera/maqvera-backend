---
title: EXT-036 — AI Agent Workflow Runtime & Execution Engine
document_id: EXT-036
version: 1.0.0
status: Production Ready (scoped)
module: AI Integration
---

# EXT-036 — AI Agent Workflow Runtime & Execution Engine

---

## 1. Audit Finding

Unusually for this series, `AIOrchestrationService.js` and `AIToolExecutionModel.js` were already citing this exact document's own section numbers (§14 Compensation, §22 Recovery, §23 Idempotency) in their docblocks before this paste — real runtime infrastructure was built incrementally across EXT-028/029 in anticipation of this document. Read every method in both files fully, end to end, before writing any code.

| § | Claim | Verdict |
|---|---|---|
| 8 "Sequential / 9 Parallel Execution" | Real, DB-backed | **Already implemented** — `parallelGroup` grouping + `Promise.allSettled`, checkpointed after every group |
| 11 "Checkpoints" | Saved after each real stage | **Already implemented** — `execution.save()` after every group, not just at the end |
| 12 "State Persistence" | Workflow ID/state/current-task/context/retry count/correlation ID, never memory-only | **Already implemented** |
| 13 "Retry Policy" | Exponential backoff, max attempts, circuit breaker | **Already implemented** (EXT-029 backoff+jitter; EXT-034 consolidated the circuit breaker into the shared Model Router) |
| 15 "Human Approval" | Pauses, resumes after decision | **Already implemented** |
| 16 "Timeout Management" | Task/workflow/approval timeout | **Already implemented** (task timeout in `AIToolRegistry.execute`; workflow ceiling in `executePlan`; approval reminder/escalation sweep) |
| 17 "Cancellation" | Recorded permanently | **Already implemented, with one real bug found and fixed** — the terminal-status guard was missing `"timed_out"`, so cancelling an already-timed-out execution silently overwrote its real state with `"cancelled"` |
| 22 "Recovery" | Resume from checkpoint, no double-execution | **Already implemented** (`recoverStuckExecutions`, idempotency-key-guarded) |
| 23 "Idempotency" | Execution ID + Idempotency Key + Task ID | **Already implemented** |
| **10 "Conditional Branching"** | **A step's execution gated on an earlier step's real result** | **Not implemented at all** — `dependsOn` only ever expressed "must have succeeded," never "must have returned X" |
| **14 "Compensation" — Monitoring visibility** | **A queryable signal, not just a side-effect** | **Partially implemented** — the real flag-for-manual-review mechanism existed (EXT-036 already correctly scoped this as "flag for human review," never a fabricated auto-rollback), but nothing about it was ever counted or exposed via `getWorkflowMetrics` |
| **22 "Recovery" — traceability** | **Which executions needed recovery, and how often** | **Not implemented** — a resumed execution looked identical to one that ran clean the first time |
| **5/21 "Archived"** | **A real terminal lifecycle state** | **Not implemented** — no archival concept existed for a formal-plan execution at all (unlike conversations, which already had one) |
| §6 "Workflow Components — Stages → Tasks → Steps" | A multi-level hierarchy | **Deliberately not built** — see §3 below |
| §18 "Event Driven Execution" | React to `PaymentReceived`/`ExternalWebhookReceived`/etc. | **Partially implemented, honestly** — real internal event-driven resumption already exists (`AIApprovalGranted` → `decideApproval` → resumes the execution); no external webhook receiver or payment gateway exists anywhere in this codebase for the rest of that list, same honest gap already flagged in EXT-029 |
| §21 "Workflow Queue — Priority Levels" | A real priority queue | **Deliberately not built** — see §3 below |
| §20 "Scheduling — Cron/Calendar/Recurring" | Real scheduled triggers | **Deliberately not built** — see §3 below |

---

## 2. What Was Built

### Real conditional branching — `runIf` (§10)

A plan step can now declare `runIf: { stepNumber, field, equals }` — it only actually runs if an **earlier step's real, persisted tool result** has that field equal to that value; otherwise it's recorded `state: "skipped"` with an honest, specific reason, exactly like an unmet dependency. `createPlan()` remaps/validates this the same way it already does for `dependsOn` (a reference to a filtered-out or non-earlier step is dropped, never left dangling) and **auto-folds the referenced step into `dependsOn`** — the engine can't evaluate a condition on a step that hasn't necessarily run yet, so this is structurally, not just conventionally, enforced.

This required a real, previously-missing piece: **`toolExecutions[].result` is now persisted** (masked the identical way `arguments` already are, via `AIGuardrailService.maskSensitiveData` — a sensitive-named field is replaced wholesale, but the boolean/numeric fields a real `runIf` condition would check, like `available` or `found`, pass through untouched). This is what makes `runIf` evaluable across a crash-recovery resume, not only within one in-memory pass. The default planning prompt (`utils/aiPromptDefaults.js`) was updated to teach the planner this capability, with an explicit instruction never to invent a field a tool doesn't actually return.

### Compensation visibility (§14/§24)

`_flagFlightForManualReview` now writes a real `compensationEvents` entry onto the execution itself (stepNumber, related step, reason, linked approval/incident IDs) — not just a side-effect on the approval row. `getWorkflowMetrics()` gained a genuine `compensationsFlagged` count, closing the one §24 monitoring metric that was previously untracked anywhere.

### Recovery traceability (§22)

`recoverStuckExecutions()` now increments a real `recoveryCount`/`lastRecoveredAt` on the execution **before** attempting the resume (so even a resume that itself fails still honestly shows an attempt was made). `getWorkflowMetrics()` gained a real `recoveredWorkflows` count.

### Real archival lifecycle (§5/§21)

`archiveExecution()` — mirrors `AIAssistantService.archiveConversation()`'s exact pattern: manual only, no fabricated automated retention sweep (this codebase's own `conversationRetentionDays` config has never had a real sweep consumer either — this doesn't invent one where none of its siblings have one). Only a genuinely finished execution (completed/failed/cancelled/rejected/timed_out) can be archived. **Deliberately does not overwrite `status`** — an execution's real outcome is meaningful data `getWorkflowMetrics`' status breakdown depends on; archival is orthogonal, signaled purely by `archivedAt`. `getWorkflowMetrics()` gained a real `archivedWorkflows` count. New endpoint: `POST /api/v1/ai/executions/:executionId/archive`.

### A real bug found and fixed

`cancelExecution()`'s terminal-status guard was missing `"timed_out"` — calling it against an already-timed-out execution fell through every branch into the final unconditional block and **silently overwrote the real timed-out state with `"cancelled"`**. Fixed by adding `"timed_out"` (and `"archived"`, now that it exists as a real signal) to the guard.

### The EXT-035 ↔ EXT-036 bridge — verified, not rebuilt

The worked example in this document's own prompt (parallel search → merge → approval → sequential booking steps) spans both `AISupervisorService`'s multi-agent parallel collaboration (EXT-035) and `AIOrchestrationService`'s durable execution runtime (EXT-036). Rather than building new plumbing to connect them, the audit confirmed — and a real isolated test proves — that the connection **already exists implicitly**: both entry points funnel every tool call through the identical `AIToolRegistry.execute()`, so a `propose_flight_booking` call made from inside the Supervisor's parallel agent turn creates the exact same kind of pending `AIApprovalRequestModel` row as one made from a formal plan, resolvable through the exact same `AIOrchestrationService.decideApproval()` — with the real, unmasked data a human approver needs intact (display-side masking never touches the operative approval record). No new bridge code was needed; this was a real architectural property to verify, not a gap to close.

### Deliberately NOT built (honest scope cuts)

- **A formal Stage → Task → Step hierarchy (§6).** The existing flat step list with `parallelGroup`/`dependsOn`/`runIf` already provides equivalent real execution capability (grouping, sequencing, conditional gating). Wrapping it in a heavier Stage/Task schema would be a large, high-risk redesign of a well-tested engine for organizational value only — no new runtime capability would result.
- **A real priority queue / distributed worker pool (§21).** This codebase has no separate worker process — every execution still runs synchronously within the request or sweep that calls `executePlan()`, the exact same honest limitation EXT-029 already disclosed for "Worker Utilization." Adding a `priority` field with no real scheduler behind it would be decorative, not functional — worse than not having it.
- **Cron/calendar/business-hours/recurring scheduling (§20).** No real business trigger for a scheduled AI workflow exists anywhere in this ERP today; building one speculatively would be encoding an untested assumption as a feature.
- **External webhook-driven event reactions (§18).** No webhook receiver or payment-gateway integration exists anywhere in this codebase (Amadeus here is synchronous request/response, never callback-driven) — the same honest gap already on record since EXT-029.
- **Temporal/LangGraph/Step Functions/etc. backend adapters (§26).** Explicitly aspirational per the document's own "Future Ready" framing.

---

## 3. Verification

14 isolated checks against the real production code (`node:test`'s `mock.module`, no live MongoDB in this environment):

- **`verify_ext036_runtime.mjs`** (11 checks): `runIf`'s `stepNumber` is genuinely auto-folded into `dependsOn`; a satisfied condition lets a step run for real; step 1's real result is persisted with its boolean field intact through masking; an unsatisfied condition genuinely skips the dependent step without ever attempting it; a real flight-succeeds/hotel-fails scenario records a real `compensationEvents` entry; `recoverStuckExecutions` genuinely increments `recoveryCount` before the resume attempt; `archiveExecution` sets `archivedAt` **without** touching the real outcome status, and correctly rejects double-archiving and archiving a non-terminal execution; the `cancelExecution` bug fix is proven — cancelling an already-timed-out execution is now rejected instead of silently corrupting its state.
- **`verify_supervisor_approval_bridge.mjs`** (3 checks): a real tool call from inside a Supervisor-coordinated parallel agent turn creates a genuine pending approval; the exact same `decideApproval()` flow resolves it; the real, unmasked data needed for the actual booking survives intact.

Full suite held at **49/49** throughout, `node --check` clean on all 5 touched files.

---

## 4. Completion Status

- **Status**: Production Ready (scoped exactly as described above)
- **Document ID**: `EXT-036`
- **Next recommended**: EXT-037 — AI Tool Registry & MCP Integration, per the source document's own pointer. Note for that audit: `AIToolRegistry.js` already has a real, working `toMCPToolDefinition`/`getMCPCatalog` (confirmed during EXT-030's audit) — the next document should verify and extend that, not assume it starts from nothing.
