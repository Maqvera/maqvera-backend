# Enterprise Standard Error Contract

**Status: ✔ Done** — hardened the shared response/validation/error-handling infrastructure every controller and route already funnels through; no individual controller files touched.

## Purpose

Provide a consistent, machine-readable error model across all APIs — a stable `code` a frontend can branch on and localize, not just a human-readable `message`.

## Envelope: adapted, not replaced

The spec's own example response is flat (`{ code, message, category, severity, httpStatus, correlationId, timestamp, details }`, no `success`/`data` wrapper). This codebase's existing `sendError(res, statusCode, message, requestId, data)` (`utils/apiResponse.js`) is used by essentially every controller and already returns `{ success, message, data, requestId }` — replacing that top-level shape would break hundreds of existing call sites. Instead, the enterprise fields nest under `data`, the same precedent Improvement 2 (Optimistic Locking) and Improvement 3 (Idempotency) already set before this standard formally existed:

```json
{
  "success": false,
  "message": "Insufficient balance.",
  "requestId": "8db79d93-...",
  "data": {
    "code": "INSUFFICIENT_BALANCE",
    "category": "Business",
    "severity": "Error",
    "httpStatus": 409,
    "correlationId": "8db79d93-...",
    "timestamp": "2027-05-10T10:35:21.000Z"
  }
}
```

`requestId` (top-level) and `data.correlationId` are deliberately the same value.

## `utils/errorContract.js`

- **`ERROR_CATALOG`** — `code -> { category, httpStatus, message }`. Covers every category example and the full "Financial Error Examples" list from the spec (`INSUFFICIENT_BALANCE`, `BUDGET_EXCEEDED`, `ACCOUNTING_PERIOD_CLOSED`, `SUBSCRIPTION_EXPIRED`, `MERCHANT_DISABLED`, `TENANT_DISABLED`, `BANK_API_TIMEOUT`, ...) plus this codebase's own already-real cross-cutting codes (`VERSION_CONFLICT`, `IDEMPOTENCY_KEY_REUSED`, etc.).
- **`AppError`** — `new AppError("INSUFFICIENT_BALANCE")` picks up category/httpStatus/message from the catalog; any field can be overridden per call site (a more specific message, or field-level `details`). An unrecognized code honestly falls back to `category: "System"`, `httpStatus: 500`, `severity: "Critical"` — never a guessed classification.
- **`buildErrorPayload(error, correlationId)`** — the pure `{ code, category, severity, httpStatus, correlationId, timestamp, details? }` builder. `details` is omitted entirely (not sent as `null`) when the error doesn't carry any.
- **`sendStandardError(res, error, requestId, extra?)`** — the real call site every `AppError`-aware handler uses. `extra` merges call-site-specific fields onto `data` (e.g. Optimistic Locking's own `currentVersion`) without a second response builder per standard.
- **`fieldDetailsFromJoiError(joiError)`** — `[{ field, message }]` from Joi's own `error.details`.

## What actually got hardened (all shared infrastructure, zero controllers touched)

| File | Change |
|---|---|
| `middleware/validateRequest.js` (`validate()`) | Every Joi-validated route in the app (hundreds of call sites) now gets real field-level `data.details: [{ field, message }]` on a validation failure. The top-level `message` stays the *exact same joined string* as before — no existing behavior changes for a caller reading only `message`. |
| `middleware/errorHandler.js` | The global unhandled-exception and 404-route handlers now emit the full standard contract. Multer's `LIMIT_FILE_SIZE`/`LIMIT_UNEXPECTED_FILE` map to real catalog codes (`FILE_TOO_LARGE`, `UNEXPECTED_FILE_FIELD`). Production still hides the real exception message behind a generic one — unchanged, still verified by test. |
| `utils/optimisticLocking.js` (Improvement 2) | `VersionConflictError`/`VersionRequiredError` are now real `AppError`s (`category: "Concurrency"`); `sendVersionConflict` now returns the full contract instead of the smaller ad hoc object it used before this standard existed. |
| `middleware/idempotency.js` (Improvement 3) | `IDEMPOTENCY_KEY_REUSED`/`IDEMPOTENCY_KEY_REQUIRED`/`INVALID_IDEMPOTENCY_KEY_FORMAT` now go through `sendStandardError` — same `code`/`correlationId` as before (no existing test-visible field changed), now also carrying `category`/`severity`/`timestamp`. |

## Sensitive details never exposed

Unchanged, verified by test: `errorHandler` only ever sends `err.stack` to the logger, never the HTTP response. `NODE_ENV=production` still replaces the real exception message with a generic `"Internal server error"`.

## Adoption

Same phased approach as every standard in this queue. The ~100 existing controllers' own `statusFromError` substring-matching pattern (`"not found"` → 404, `"already exists"` → 409, etc. — see `CLAUDE.md`) is **not** retrofitted onto `AppError`/`sendStandardError` in this pass — that is real, deliberate, separate follow-up work, module by module. What's real *today*: every route behind `validate()`, the global error handler, and both existing cross-cutting standards (Optimistic Locking, Idempotency) already speak the full contract.
