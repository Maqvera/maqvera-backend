# Enterprise Correlation & Traceability Standard

**Status: ✔ Done** — real, automatic propagation via `AsyncLocalStorage`, not a documented convention. Zero controller/service files touched.

## Purpose

End-to-end request tracing across every service a single request touches (Sales → Finance → Approval → Tax → Currency → Notification → Audit → Search), without a developer having to remember to thread an id through every function call.

## What already existed

`middleware/requestContext.js` already generated a real UUID v4 (`crypto.randomUUID()`) per request, accepted a client-supplied `X-Request-ID`, echoed it on the response, and threaded it through `req.requestId` — into `sendSuccess`/`sendError`'s `requestId` field and many (not all) `AuditLogModel.create`/`publishEvent` calls that explicitly passed it along. The gap: propagation past the controller was **entirely manual, per call site** — easy to forget, and the majority of this codebase's existing `publishEvent(...)`/`logger.*(...)` calls never passed a correlationId at all.

## The real fix: `AsyncLocalStorage`, not a bigger retrofit

Threading a `correlationId` parameter through every service method, every `publishEvent` call, and every `logger.*` call across this entire codebase would be exactly the kind of full, all-module retrofit this hardening phase's own approach defers. Instead, `utils/correlationContext.js` opens one `AsyncLocalStorage` store per request (`middleware/requestContext.js` wraps `next()` in `runWithCorrelationId`) — the same underlying primitive the spec's own "Future support: OpenTelemetry... Correlation ID becomes the trace root" line points at. Everything that runs inside that request's async call chain — every controller, every service, every `publishEvent`, every `logger.*` call — can read the current correlationId back with **zero parameters threaded through any of them**.

## What changed (four shared files, zero controllers)

| File | Change |
|---|---|
| `middleware/requestContext.js` | Now accepts `Correlation-ID` (the spec's own header name, checked first) or `X-Request-ID` (unchanged, still the primary name every existing test/log line already reads via `req.requestId`) from the client; generates a real UUID v4 if neither is present; returns **both** header names on the response with the same value; opens the `AsyncLocalStorage` context for the rest of the pipeline. |
| `utils/eventBus.js` (`publishEvent`) | Every event now carries a real `correlationId` — an explicit `payload.correlationId` always wins (e.g. a scheduler replaying a stored event on purpose); otherwise falls back to the ambient request's id; honestly `null` outside any request context (a cron scheduler). This is real for **every existing `publishEvent` call site in the codebase automatically**. |
| `utils/logger.js` | A Winston format stamps `correlationId` onto every log entry from the ambient context, unless the call site already supplied its own (which always wins). Real for **every existing `logger.info/warn/error` call automatically** — schedulers running outside any request honestly get no `correlationId` key at all, never a fabricated one. |
| `models/AuditLogmodel.js` | `requestId`'s default value (which only fires when a caller omits it) now resolves the real ambient correlationId first, falling back to the old `system-<timestamp>-<random>` placeholder only outside any request context. Any caller that already passes its own `requestId` is untouched. |

## Rules

1. Every request MUST have a unique Correlation-ID — real, `crypto.randomUUID()`.
2. If the client omits it, the platform MUST generate one — real, same UUID v4 generator either way.
3. The same Correlation-ID MUST be propagated across services, events, logs, and audits — real, via `AsyncLocalStorage`, not manual threading.
4. Every response MUST return the Correlation-ID — both `X-Request-ID` and `Correlation-ID` headers, same value.
5. Every domain event MUST include the Correlation-ID — real, `publishEvent`'s own fallback.
6. Correlation-ID MUST be retained in audit records — real, `AuditLogModel`'s own default.

## Real end-to-end proof (`tests/correlationIdStandard.test.js`)

Concurrent, isolated `AsyncLocalStorage` contexts; header precedence and UUID v4 generation; a published event auto-carrying the ambient correlationId (and an explicit one still winning); a real Winston log line captured via a temporary transport showing the stamped `correlationId`; a real `AuditLogModel` row created without an explicit `requestId` resolving the true ambient id, and the honest `system-` fallback outside any request context.

## Adoption

`eventVersion` on domain events (the spec's own Domain Event Standard example) is **not** added here — that's Improvement 7 (Event Versioning), a distinct, larger concern (schema evolution across event consumers), not attempted as a side effect of this one. Per-log-line `tenantId`/`merchantAccountId`/`companyId`/`branchId` remain call-site-specific, same as every other opt-in field in this hardening phase — nothing here forces them onto a log call that doesn't already pass them.
