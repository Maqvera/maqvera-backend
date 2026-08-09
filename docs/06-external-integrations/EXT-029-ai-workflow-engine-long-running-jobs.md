---
title: EXT-029 — AI Workflow Engine & Long Running Jobs
document_id: EXT-029
version: 1.0.0
status: Production Ready (scoped)
module: AI Integration
---

# EXT-029 — AI Workflow Engine & Long Running Jobs

---

## 1. Audit Finding

Durable execution itself — the headline claim of this document — is already real, built across EXT-036/EXT-028 earlier this session: per-group checkpointing, crash recovery, idempotency keys, dependency-aware skipping, cooperative cancellation. Six real gaps remained, plus several sections that are honestly **not applicable** to how this codebase's Amadeus integration actually works (worth stating plainly rather than silently ignoring):

| § | Claim | Verdict |
|---|---|---|
| 1–4, 7, 9, 12, 13, 16, 17, 19, 20, 21 | Durable state persistence, retry, parallel tasks, compensation-as-flagging, workflow lifecycle, variables (all covered by EXT-027's session memory), tenant/permission validation, audit | Already implemented |
| **6** | **Workflow States — "Timed Out"** | **Not implemented** — no execution-level timeout existed at all |
| **8/11** | **Timer / "Retry -> Exponential Backoff"** | **Not implemented** — `AI_TOOL_DEFAULT_TIMEOUT_MS` was dead config (decorative catalog metadata only, never enforced against a running call); a retried step fired again immediately with zero delay, no backoff |
| **10/14** | **Event Waiting — "Waiting Approval -> Approve -> Resume"** | **Partially implemented, and actively broken** — approving/rejecting a request updated only the `AIApprovalRequestModel` row; the linked execution stayed at `awaiting_approval` forever, even after a human decided. "Resume" never actually happened |
| **15** | **Timeout Handling — Approval Timeout -> Reminder -> Escalation -> Auto Cancel** | **Not implemented** — nothing ever reminded or escalated a stale pending approval |
| **18** | **Monitoring** | **Not implemented** — no aggregated workflow metrics existed |
| **10 (Provider Callback / Webhook Wait)** | "Workflow may pause until ... Provider Callback ... resumes automatically" | **Not applicable, not fabricated** — no webhook/callback receiver exists anywhere in this codebase (confirmed by search); the real Amadeus integration here is synchronous REST request/response, not callback-driven. `awaiting_approval` (a genuine human-sourced event) is the one wait-state this codebase can honestly claim |
| §3 "Workers" | A separate worker pool | **Not applicable** — execution runs synchronously within the request/sweep that calls `executePlan()`, the same single-instance architecture already documented elsewhere in this codebase (`utils/eventBus.js`'s own caveat) |
| §6 "Compensated" | A distinct terminal state | **Deliberately not added** — this codebase's compensation is "flag for manual review", never an automatic rollback (unchanged since EXT-036); a "compensated" status would overstate what actually happened |

One explicit product decision was confirmed before building rather than guessed: **pending approvals get reminder + escalation notifications, but are never auto-rejected** — every real booking/cancellation proposal only resolves through an actual human decision.

---

## 2. What Was Built

### Real per-step timeout + exponential backoff (§8/§11)

`AIOrchestrationService.runStep()` now wraps every tool call in `withTimeout()` (`Promise.race` against `AI_TOOL_DEFAULT_TIMEOUT_MS`, previously unused catalog decoration, now actually enforced) and inserts a real, jittered exponential-backoff delay (`AI_RETRY_BASE_DELAY_MS` / `AI_RETRY_BACKOFF_MULTIPLIER` / `AI_RETRY_MAX_DELAY_MS`) before each retry attempt — previously a failed step retried immediately, back-to-back, hammering a struggling provider. Honestly documented: racing a call doesn't abort it — a losing call may still complete in the background; this is exactly why EXT-036 §23's idempotency key exists, so a late-completing `propose_*` call still can't create a duplicate approval.

### Whole-workflow timeout (§6/§15)

A new `AI_WORKFLOW_MAX_DURATION_MS` ceiling, checked at the exact same cooperative checkpoint boundary EXT-028's cancellation already added. On breach: `status` becomes the new `"timed_out"` value, every step that never started is recorded, already-completed results are kept, no synthesis pass runs — reusing the same halt/finalize logic cancellation uses (refactored into one shared `haltReason` path instead of two near-duplicate blocks).

### Approval decision actually resumes the execution (§10/§14)

`decideApproval()` now checks, after saving a decision, whether the linked execution has any other approvals still `pending`; once none remain, the execution transitions out of `awaiting_approval` to `completed` (each individual approval's own approved/rejected outcome remains the authoritative record — the execution-level status doesn't try to re-encode a compound mix). This was a genuine, previously-broken piece of "workflow resumes automatically" — before this, an execution could sit at `awaiting_approval` forever even after a human acted.

### Approval reminder + escalation (§15)

New `services/aiApprovalTimeoutScheduler.js` — a cron sweep (`AI_APPROVAL_TIMEOUT_CRON_SCHEDULE`) that sends a `NotificationRequested`/`AIApprovalReminder` event after `AI_APPROVAL_REMINDER_AFTER_MS`, then `AIApprovalEscalated` after `AI_APPROVAL_ESCALATION_AFTER_MS`, tracked via new `reminderSentAt`/`escalatedAt` fields so each fires at most once. No auto-reject exists, per the confirmed decision.

### Workflow metrics (§18)

`AIOrchestrationService.getWorkflowMetrics({tenantId})` — a real MongoDB aggregation (status breakdown, average duration over terminal executions, total retries, approval decision-delay average) exposed at admin-only `GET /api/v1/ai/executions/metrics` (mirrors `AmadeusMetricsController`'s own admin gate). Deliberately has no "Worker Utilization" or "Provider Failures" figures — no worker pool exists to measure, and `GdsIntegrationService`'s own circuit breaker (`GET /api/v1/integrations/amadeus/metrics`) is already the real provider-failure signal; duplicating it from tool-error strings here would be a guess, not a measurement.

---

## 3. Verification

19 isolated checks against the real production code (`node:test`'s `mock.module`, no live MongoDB in this environment): a hung tool call is actually timed out and recovers on retry; backoff delay is real (measured wall-clock gaps, growing between attempts, not fixed); a workflow exceeding its max duration halts at the next group boundary, keeps completed results, records the rest honestly, skips synthesis; a single pending approval resolves its execution on decision; two pending approvals only resolve the execution once **both** are decided (even a mixed approve/reject outcome); an approval with no `executionId` never touches any execution; an execution not currently `awaiting_approval` is never force-finalized; `getWorkflowMetrics()` returns honest zeros/nulls rather than fabricated numbers when no DB is connected.

Full suite held at **49/49**, `node --check` clean on every touched file.

---

## 4. Completion Status

- **Status**: Production Ready (scoped exactly as described above)
- **Document ID**: `EXT-029`
- **Next recommended**: EXT-030 — AI Knowledge & Context Retrieval (RAG Layer), per the source document's own pointer — genuinely new ground; nothing in this codebase currently retrieves internal SOPs/visa rules/policy documents for the AI to ground answers in.
