# Enterprise Concurrency Control Standard (Optimistic Locking)

**Status: ✔ Done** — real, tested infrastructure (`utils/optimisticLocking.js`), not yet wired into any existing update endpoint (see "Adoption" below).

## Purpose

Prevent lost updates in concurrent environments while preserving financial integrity. Two managers opening the same Invoice and both saving must never silently let the second save erase the first.

## Rules

1. Every mutable entity MUST include a `version` field (`__v`, exposed as `version` via `exposeVersion()` — Standard Metadata, Improvement 1).
2. Update APIs MUST require `version` (request body) or `If-Match` (request header) — never silently default to "whatever is current."
3. If the supplied version does not match the current version, the server MUST return HTTP 409 with `{ code: "VERSION_CONFLICT", message, currentVersion, correlationId }`.
4. Posted financial records remain immutable and are excluded from optimistic locking (they have no update path to begin with).
5. Every version conflict MUST be audit logged with its `correlationId`.

## How it works (`utils/optimisticLocking.js`)

- **`extractRequestedVersion(req)`** — reads `body.version`, falling back to `If-Match` (accepts the `W/"8"` and `"8"` forms real HTTP caching/ETag clients send). Returns `null` when neither is present — `0` is a real, valid version and is never confused with "missing."
- **`applyOptimisticUpdate({ Model, filter, requestedVersion, update, resourceType, tenantId, correlationId, userId })`** — the real compare-and-swap. The version check and the write happen in **one atomic `findOneAndUpdate`** (`{ ...filter, __v: requestedVersion }`), so there is no separate "read version, then write" gap a second concurrent request could land in — the exact TOCTOU race a naive "check then save" would still have.
  - No match found → distinguishes **not found** (plain `Error` containing "not found", the existing controller-error-mapping convention → 404) from **version conflict** (`VersionConflictError`, carries the real `currentVersion` read fresh from the database) by re-reading the document without the version filter.
  - A version conflict is audit-logged (`action: "concurrency.version_conflict"`) with the real `correlationId`, `tenantId`, `resourceId`, requested vs. current version — before the error is thrown.
  - Missing version → `VersionRequiredError` (400), never a silent unconditional write.
- **`assertMutableResource(resourceType)`** — rejects immutable, append-only types (`utils/concurrencyConfig.js`: Journal, AuditLog, LedgerEntry, PostedPayment/Invoice/Receipt/Expense, DomainEvent, GeneratedNumber) outright.
- **`sendVersionConflict(res, error, requestId)`** — the standard 409 response envelope, ready to call from any controller's `catch` block.
- **`requireVersion()`** — optional Express middleware that rejects a missing/malformed version before any business logic runs, for routes that want it mounted directly.

## Usage

```js
// services/SomeService.js
import { applyOptimisticUpdate, VersionConflictError } from "../utils/optimisticLocking.js";

static async updateInvoice(tenantId, invoiceId, requestedVersion, changes, userId, correlationId) {
  return applyOptimisticUpdate({
    Model: InvoiceModel,
    filter: { _id: invoiceId, tenantId },
    requestedVersion,
    update: { $set: changes, updatedBy: userId },
    resourceType: "Invoice",
    tenantId, correlationId, userId
  });
}
```

```js
// controllers/SomeController.js
import { extractRequestedVersion, VersionConflictError, VersionRequiredError, sendVersionConflict } from "../utils/optimisticLocking.js";

try {
  const version = extractRequestedVersion(req);
  const updated = await SomeService.updateInvoice(scope.tenantId, req.params.id, version, req.body, userId, req.requestId);
  return sendSuccess(res, 200, "Invoice updated.", updated, req.requestId);
} catch (error) {
  if (error instanceof VersionConflictError) return sendVersionConflict(res, error, req.requestId);
  if (error instanceof VersionRequiredError) return sendError(res, 400, error.message, req.requestId, { code: error.code });
  // ...existing statusFromError substring-mapping fallback...
}
```

## Adoption

Same phased approach as every Enterprise Standard in this queue: the mechanism is real and fully tested (`tests/optimisticLockingStandard.test.js` — including a genuine two-manager lost-update scenario proving the second, stale write is rejected and the first write survives) but **not yet wired into any existing PUT/PATCH controller**. Rolling it onto the mutable modules the spec names (Customers, Vendors, Tax Rules, Currency, Pricing Rules, Budget, Forecast, Approval Workflow, Expense/Payment drafts, Reports/Dashboard/Search configuration) is real, deliberate, separate follow-up work, module by module.
