# Enterprise Idempotency Standard

**Status: ✔ Done** — hardened the shared middleware every already-mounted financial POST route depends on; no route/controller files touched.

## Purpose

Prevent duplicate execution of financial operations caused by retries, network failures, or client-side resubmissions ("customer clicks Pay Invoice twice").

## What already existed

`middleware/idempotency.js` + `models/IdempotencyKeyModel.js` were already real and already mounted on ~20 financial POST endpoints (`routes/FinanceRoutes.js`'s journals/payments/customer-payments/wallets/subscriptions/currency routes, plus `MerchantPlatformRoutes.js`, `NumberingRoutes.js`, `OrganisationRoutes.js`, and others). The header-present / lookup / replay-cached-response mechanism worked. This item hardens that ONE shared middleware — which upgrades every route already using it at once — rather than retrofitting routes individually.

## The real gap that was closed

The previous version replayed whatever response was stored for a key **regardless of whether the retried request's payload actually matched**. A client accidentally (or maliciously) reusing the same `Idempotency-Key` with a *different* payload got back the *original, unrelated* response silently — never the enterprise-mandated `409 IDEMPOTENCY_KEY_REUSED`. That is now a real, tested rejection.

## Rules

1. Every financial POST endpoint MUST accept an `Idempotency-Key` header (UUID format validated — malformed keys are rejected `400 INVALID_IDEMPOTENCY_KEY_FORMAT` before any lookup).
2. The server MUST store the request hash (SHA-256 over the body) and response for successful processing.
3. Repeated requests with the same key and identical payload MUST return the original response without re-executing business logic.
4. Reusing the same key with a different payload MUST return `409 { code: "IDEMPOTENCY_KEY_REUSED", message, correlationId }`.
5. Idempotency records MUST be tenant-isolated (the compound unique index is `(tenantId, idempotencyKey)` — two tenants can use the identical UUID with zero collision).
6. Every idempotency decision (stored / replayed / conflict) MUST be audit logged with its `correlationId`.
7. Idempotency storage MUST expire based on a configurable retention policy (`utils/idempotencyConfig.js` — 24h floor, 72h default/recommended, 30-day ceiling, `IDEMPOTENCY_KEY_TTL_SECONDS`).

## Backward compatibility

The header stays **optional by default** (`idempotency()`, unchanged from before) — every currently-mounted route keeps its exact existing contract; no client that omits the header is newly rejected. A new `idempotency({ required: true })` mode is available for a route that wants to reject a missing key outright (`400 IDEMPOTENCY_KEY_REQUIRED`), not turned on anywhere in this pass — a deliberate per-route decision, not a blanket one.

`merchantAccountId` is recorded on the stored record when present in the request body (mirrors Standard Metadata's own opt-in field), but is not a second required isolation dimension — the real, structural isolation boundary stays `tenantId`, consistent with this codebase's architecture (`utils/accessScope.js`). A request-hash mismatch already catches a payload that differs by `merchantAccountId` too, since it's part of the hashed body.

## Real end-to-end proof (`tests/idempotencyStandard.test.js`)

Against a live database: first request executes and is stored; an identical retry replays the original response **without re-running business logic** (the actual duplicate-payment prevention, not just a documented intent); a same-key-different-payload request is rejected `409`; all three decisions produce the expected audit trail (`idempotency.stored` → `idempotency.replayed` → `idempotency.key_reused`) in order. Plus format validation, `required: true`, and the no-tenant-context skip.
