# Enterprise Data Retention & Legal Hold Standard

**Status: ✔ Done** — real, tested registries and workflows (`utils/retentionPolicy.js`, `utils/legalHold.js`, `utils/purgeRequest.js`); extends Improvement 10's already-real archive/purge engine rather than duplicating it.

## Relationship to Improvement 10

Improvement 10 (Soft Delete & Archival) already built the real mechanics: `applyArchivalPolicy`'s `legalHold`/`legalHoldReason`/`purgeEligibleAt` fields, and `purgeRecord`'s gate chain that checks them. This standard is the **registry and workflow layer** on top of those same fields — a full Legal Hold history (a resource can be under more than one investigation at once), a configurable Retention Policy catalog (instead of one flat config number), and a request/approve gate for the "no automatic deletion without approval" rule. Nothing here duplicates Improvement 10's actual purge mechanics.

## Retention Policy Registry (`utils/retentionPolicy.js`, `models/RetentionPolicyModel.js`)

One real, upsert-safe policy per `(tenantId, resourceType)`. `resolveRetentionYears` is the real resolution order `archiveRecord` (Improvement 10, now enhanced) uses: **a registered policy first**, then the config's own per-resourceType default table (the spec's own compliance matrix — Journal/Invoice/Payment/Receipt 10 years, Forecast/Analytics 5 years, Integration Logs 2 years, Notifications 1 year), then an honest fallback — never a silently guessed number. Re-registering an identical policy is a safe no-op; an actual change to the retention window publishes `RetentionPolicyChanged.v1`.

`archiveRecord` now also stamps the resolved `retentionPolicy` code onto the archived document (a new field added to `applyArchivalPolicy`) and publishes a real `RetentionStarted.v1` — "Archived → Retention Countdown Starts" — alongside the existing `RecordArchived.v1`.

## Legal Hold Registry (`utils/legalHold.js`, `models/LegalHoldModel.js`)

A Legal Hold is its own first-class, queryable record, not just the boolean flag. **A resource can genuinely be under two independent holds at once** (a tax investigation and a fraud investigation, opened and closed on their own timelines) — `applyLegalHold` creates a new hold row every time; `removeLegalHold` only clears the target document's `legalHold` flag once **every** active hold against it has been removed, verified by a real count, not assumed. `getLegalHoldStatus` is the real backing for "Search Behaviour — users immediately know why a record cannot be deleted." `LegalHoldApplied.v1`/`LegalHoldRemoved.v1` fire on every transition.

## Purge Request Workflow (`utils/purgeRequest.js`, `models/PurgeRequestModel.js`)

"No automatic deletion without approval." A real, simple `Pending → Approved/Rejected → Completed` gate — deliberately not a second implementation of this codebase's own general-purpose `services/ApprovalWorkflowService.js`. **A legal hold blocks both requesting and approving a purge**, checked independently at each step (a hold applied *after* a request was created still blocks approval). Approving a request does not itself delete anything — the caller takes the request's real `approvedBy` and passes it into Improvement 10's own `purgeRecord`, which re-checks retention/legal-hold independently before the actual `deleteOne`. `markPurgeRequestCompleted` closes the loop once that real purge has genuinely happened, so "Purge History" reflects reality.

## Domain Events

`RetentionStarted.v1`, `RetentionExpired.v1` (already fired by Improvement 10's `purgeRecord`), `LegalHoldApplied.v1`, `LegalHoldRemoved.v1`, `PurgeApproved.v1`, `RetentionPolicyChanged.v1`. `PurgeCompleted.v1` is deliberately **not** a separate event — Improvement 10's existing `RecordPurged.v1` already is that real signal; firing a second, redundant event for the identical fact would be noise, not a new capability.

## Real end-to-end proof (`tests/dataRetentionStandard.test.js`)

A registered policy genuinely overriding the config default (and changing `archiveRecord`'s real computed `purgeEligibleAt`); a resource under two simultaneous legal holds where the flag only clears after both are individually removed; a legal hold blocking a purge request at both the request and approval steps; and the complete `requestPurge → approvePurge → purgeRecord → markPurgeRequestCompleted` pipeline working end to end against a real document that is genuinely deleted at the end.

## Adoption

No existing controller exposes `POST /api/v1/legal-hold` or a retention-policy/purge-request management API in this pass. Real, deliberate, separate follow-up — the same phased approach as every other standard in this hardening phase.
