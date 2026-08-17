# Enterprise Soft Delete & Archival Standard

**Status: ✔ Done** — real, tested workflow engine (`utils/archivalService.js`); not wired into any existing controller in this pass.

## What already existed

"Financial records are NEVER physically deleted." This codebase already follows that rule in practice — no `deleteOne`/`deleteMany`/`findOneAndDelete` exists anywhere against `InvoiceModel`, `PaymentModel`, `JournalModel`, `ReceiptModel`, `CreditNoteModel`, or `DebitNoteModel` today (verified by grep across every controller/service). The real gap: no reusable *workflow* for the spec's own `Active → Archived → Restored → Retention Ends → Legal Review → Secure Purge` lifecycle, and no domain events for it.

## `utils/archivalPolicy.js` — the metadata

A companion plugin to Improvement 1's `applyEnterpriseMetadata`, same collision-safe `addIfMissing` shape: `isArchived`, `archivedAt`, `archivedBy`, `archiveReason`, `restoredAt`, `restoredBy`, `legalHold`, `legalHoldReason`, `purgeEligibleAt`, `purgedAt`, `purgedBy`. `status` itself is deliberately untouched — every model already owns its own richer status enum (same reasoning as Improvement 1).

## `utils/archivalService.js` — the workflow

- **`assertHardDeleteAllowed(resourceType)`** — the spec's own two lists, made real: financial resource types (Journal, Invoice, Payment, Receipt, TaxRecord, Asset, AuditRecord, CreditNote, DebitNote, LedgerEntry) always throw; only the explicit operational allow-list (Temporary Reports, Cache, Sessions, Temporary Uploads, Search Cache) is permitted.
- **`archiveRecord`** — "Permission Validation → Accounting Period Check → Archive Metadata Added → Audit Record Created → Archived." The accounting-period check reuses the **already-existing** `FinancialPeriodService.assertPeriodOpen` (Journal/Ledger's own "posting allowed only in Open Period" rule) rather than building a second one — a closed period rejects the archive attempt (`422 ACCOUNTING_PERIOD_CLOSED`), audit-logs the rejection, and publishes `ArchiveRejected.v1`. A successful archive computes a real `purgeEligibleAt` from the retention-policy config (7 years default) and publishes `RecordArchived.v1`.
- **`restoreRecord`** — real state check (cannot restore something that isn't archived); clears `purgeEligibleAt`; publishes `RecordRestored.v1`.
- **`purgeRecord`** — the full secure-purge gate chain, in order: must already be archived → no active legal hold → retention genuinely expired (`purgeEligibleAt` in the past) → an explicit `approvedBy` (a real userId — proof an approval already happened upstream, e.g. via the existing `ApprovalWorkflowService`; this file does not implement a second approval state machine). Only after every gate passes: `RetentionExpired.v1` fires, a **full document snapshot** is written to the audit log ("Secure Purge → Audit Log Retained" — the audit row IS the retained record once the document itself is gone), the document is genuinely `deleteOne`'d, and `RecordPurged.v1` fires. This is the one and only real hard delete in the entire file.

Permission checks ("who is allowed to archive/restore/purge") are the **caller's** responsibility — this file never hardcodes a role-name allowlist ("Finance Manager, Controller, CFO..."); a real controller would gate on `req.auth.permissions`, this codebase's actual RBAC mechanism everywhere else (and the one `tests/accessScopeRegression.test.js` already fails the build on if violated).

## Domain Events

`RecordArchived.v1`, `RecordRestored.v1`, `ArchiveRejected.v1`, `RetentionExpired.v1`, `RecordPurged.v1` — all published through Improvement 7's `publishVersionedEvent`, carrying the real standard envelope (correlationId, source, nested `data`).

## Real end-to-end proof (`tests/archivalStandard.test.js`)

Against a real, live collection: the full `Active → Archived → Restored` cycle with real audit trail and event verification; a genuine closed-accounting-period rejection (a real `FinancialPeriodModel` row, `assertPeriodOpen` actually invoked); and the complete secure-purge gate chain — rejected for not-yet-archived, missing approval, retention-not-expired, and active legal hold, each independently — before a final successful purge that genuinely deletes the document and leaves a full snapshot in the audit log.

## Adoption

No existing model gets `applyArchivalPolicy` in this pass, and no existing controller exposes `POST /:id/archive`/`POST /:id/restore`. Real, deliberate, per-module follow-up: each financial model needs its own decision about which date field represents its "accounting period" for the archive-time check (an Invoice's `issueDate`, a Journal's `postingDate`, ...).
