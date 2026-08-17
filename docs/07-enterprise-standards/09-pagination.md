# Enterprise Standard Pagination Model

**Status: ✔ Done** — real, tested utility (`utils/pagination.js`); no existing list endpoint's response shape is changed.

## Why this is additive, not a rename

Essentially every list endpoint in this codebase — including every one built earlier in this hardening phase (Organisation, Numbering, Resilience DLQ, Event Registry, API Version Registry) — already returns the same de facto shape: `{ items, pagination: { total, page, pageSize, totalPages } }`. The spec's own recommended envelope uses different field names (`data`, `totalRecords`, plus `hasNext`/`hasPrevious`/`nextCursor`/`previousCursor`/`metadata`). Renaming `items` → `data` and `total` → `totalRecords` across every existing controller would be exactly the kind of mass, breaking rewrite this hardening phase's whole approach avoids. `utils/pagination.js` is real, new infrastructure producing the spec's **exact** envelope, ready for any endpoint that adopts it going forward.

## Two real modes

### Offset — `paginateOffset` (`utils/pagination.js`)
"Best for Invoices, Customers, Vendors, Products, Employees, Payments, Receipts." Real `.skip()/.limit()`, `countDocuments`, and **deterministic ordering**: the configured tiebreaker (`_id`) is always appended after the caller's own sort field — "otherwise page 2 may contain duplicates or missing rows if new data arrives" or if two documents share the same primary sort value.

### Cursor — `paginateCursor` (`utils/pagination.js`)
"Best for Audit Logs, Event Store, Search, Notifications, Analytics, Financial Transactions." Real `_id`-based keyset pagination — no `skip()` at all (a `page=50000` offset scan is exactly what this mode exists to avoid). `nextCursor` is straightforward: the id of the last row returned. `previousCursor` is real, not fabricated, but requires the caller to flip `order` when following it — the same internal technique Relay-style `before`/`after` cursor APIs use: the response's `data` array needs to be reversed by the caller after following `previousCursor`. Documented explicitly in the function's own comment, not hidden.

## Real validation, not silent clamping

"Requests like `pageSize=100000` → Reject 400 Bad Request." Every existing paginated endpoint in this codebase silently *clamps* an out-of-range `pageSize` via `Math.min(Math.max(...))` — a deliberately different, more permissive behavior than what this new standard requires. `parsePaginationParams` genuinely **rejects** (`VALIDATION_FAILED`, field-level `details`) an invalid `page`, an invalid `pageSize`, a `pageSize` beyond the configured ceiling, an invalid `order`, or a `sort` field not on the caller-supplied allow-list (preventing an arbitrary/unsafe sort field from ever reaching a Mongo query). `maxPageSize` per call site is itself capped at `absoluteMaxPageSize` (500 by default) — no endpoint can opt into an unbounded result set no matter what it configures.

## The standard envelope

```json
{
  "data": [ ],
  "pagination": {
    "page": 1, "pageSize": 25, "totalRecords": 10524, "totalPages": 421,
    "hasNext": true, "hasPrevious": false,
    "nextCursor": "abc123", "previousCursor": null
  },
  "metadata": { "correlationId": "ABC-123", "generatedAt": "2027-06-01T10:00:00.000Z" }
}
```

`metadata.correlationId` falls back to the ambient `AsyncLocalStorage` context (Improvement 5) when not explicitly supplied — same zero-touch propagation as everywhere else this phase has used it. Offset results leave `nextCursor`/`previousCursor` null; cursor results leave `page`/`totalRecords`/`totalPages` null (a keyset scan never counts the whole collection — that would defeat its own purpose).

## Usage

```js
const result = await paginateOffset({
  Model: InvoiceModel,
  filter: { tenantId },
  query: req.query,                                    // page, pageSize, sort, order
  allowedSortFields: ["createdAt", "invoiceNumber", "amount", "status"]
});
return sendSuccess(res, 200, "Invoices retrieved.", result, req.requestId);
```

```js
const result = await paginateCursor({
  Model: AuditLogModel,
  filter: { tenantId },
  query: req.query                                      // cursor, pageSize, order
});
```

## Real end-to-end proof (`tests/paginationStandard.test.js`)

Against a real collection (`AuditLogModel` — the spec's own recommended cursor-pagination use case): validation rejecting every bad input case; deterministic offset paging across a known 23-record dataset with zero duplicates/gaps across pages; real ascending/descending sort verified on actual field values; a full 25-record cursor traversal via repeated `nextCursor` yielding the dataset exactly once; a rejected tampered cursor; and genuine forward-then-backward navigation — following `previousCursor` with `order` flipped and the result reversed recovers the exact prior page.

## Adoption

No existing controller is migrated to `paginateOffset`/`paginateCursor` in this pass. Real, deliberate, per-endpoint follow-up work — each migration is a real behavior change (silent clamping → real 400 rejection) worth its own review, not a mechanical find-and-replace.
