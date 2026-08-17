# Enterprise Resilience & Reliability Standard

**Status: ✔ Done** — real, tested fault-tolerance engine (`utils/resilienceEngine.js`); not yet wired into any existing external-integration adapter (see "Adoption" below).

## Purpose

Fault tolerance and reliable communication with external systems (Bank APIs, payment gateways, tax authorities, exchange-rate providers, email/SMS providers, government APIs) — retry, timeout, circuit breaker, and Dead Letter Queue as one coherent mechanism, not four separate ad hoc ones per integration.

## Components

| Piece | File |
|---|---|
| Per-integration retry/timeout config (Bank API 5 retries/30s, Exchange Rate 3/10s, Email 3/15s, ...) | `utils/resilienceConfig.js` |
| Retryable vs. non-retryable classification (the spec's own two tables: 500/502/503/504/timeouts retryable; 401/403/404/409/422/duplicate-payment never retried) | `utils/resilienceConfig.js` (`isRetryableError`) |
| Exponential backoff with **equal jitter** (delay always in `[half, full]` of the capped exponential value — grows visibly like the spec's own `1s → 2s → 4s → 8s → 16s` example while still spreading concurrent retries out) | `utils/resilienceEngine.js` (`computeBackoffDelayMs`) |
| Circuit Breaker — `Closed → Open → HalfOpen → Closed`, in-memory per-process hot-path state (a DB round trip before every external call would defeat a fast-fail breaker), durable transition history in Mongo for the dashboard | `utils/resilienceEngine.js` + `models/CircuitBreakerStateModel.js` |
| Dead Letter Queue — real, durable record once the retry budget is exhausted, with the original `payload` so a message is actually re-runnable, not just a historical log line | `models/DeadLetterQueueModel.js` |
| The real orchestrator every external call should go through | `utils/resilienceEngine.js` (`executeResilientOperation`) |

## `executeResilientOperation`

```js
const result = await executeResilientOperation({
  integration: "BankAPI",       // looks up timeout/maxRetries from utils/resilienceConfig.js
  module: "Payments",
  operationLabel: "BankSync",
  tenantId, correlationId, idempotencyKey,   // preserved verbatim across every retry and onto the DLQ row
  payload: { paymentId, amount },            // stored on the DLQ row so a failed message can actually be replayed
  run: async (signal) => axios.post(bankUrl, body, { signal })   // MUST respect the AbortSignal for the timeout to be real
});
```

- **Circuit open at the start** → fails fast immediately, `run` is never called, nothing is queued (nothing was actually attempted).
- **Circuit opens mid-retry-loop** (this operation's own failures tripped the threshold) → the attempts already made go straight to the DLQ.
- **Non-retryable failure** (401/403/404/409/422, duplicate payment, ...) → thrown immediately. Never retried, never counted against the circuit breaker (it reflects the *external system's* health, not a business/client-side rejection), never queued.
- **Retry budget exhausted on a retryable failure** → a real `DeadLetterQueueModel` row is created (`RetryExhausted.v1` + `DeadLetterQueued.v1`), and the caller receives a standard `AppError("EXTERNAL_SERVICE_ERROR")` (Improvement 4) carrying the real `dlqId`.
- **A retry succeeds** → `RetrySucceeded.v1` fires (only for `attempt > 1` — a normal first-try success isn't "a retry succeeding").

## Reprocessing

`reprocessDeadLetter(dlqId, run, userId)` — `run` is supplied by the **caller**, because only the one module that originally made the call knows how to genuinely re-execute it; a fully generic, serialized function replay isn't real or safe over HTTP/Mongo. A failed manual retry stays `Pending` (still actionable, never automatically terminal) — `markDeadLetterPermanentFailure(dlqId, reason, userId)` is the deliberate, explicit act that ends the story.

## API (`/api/v1/resilience`) — read-only + one terminal action

| Method | Path | Permission | Purpose |
|---|---|---|---|
| GET | `/dead-letters` | `resilience.read` | List the tenant's DLQ records (`?status=`, `?integration=`, `?module=`) |
| GET | `/dead-letters/:dlqId` | `resilience.read` | Get one DLQ record |
| POST | `/dead-letters/:dlqId/permanent-failure` | `resilience.manage` | Give up on a record explicitly |
| GET | `/circuit-breakers` | `resilience.read` | Current state of every integration this process has ever called |

Generic `POST /dead-letters/:id/reprocess` is deliberately **not** exposed — see `reprocessDeadLetter`'s own doc comment above for why a real executor can't be supplied generically over HTTP. A real per-integration retry endpoint (e.g. `POST /api/v1/finance/bank-sync/:dlqId/retry`) would call `reprocessDeadLetter(dlqId, () => BankSyncService.sync(dlq.payload), userId)` with its own real function — genuine, deliberate follow-up work per integration.

## Domain Events

`RetryScheduled.v1`, `RetrySucceeded.v1`, `RetryExhausted.v1`, `CircuitOpened.v1`, `CircuitClosed.v1`, `DeadLetterQueued.v1`, `DeadLetterReprocessed.v1`, `IntegrationRecovered.v1` — every one carries the real `correlationId` (Improvement 5's own `AsyncLocalStorage` fallback applies here too, same as any other `publishEvent` call).

## Real end-to-end proof (`tests/resilienceStandard.test.js`)

Real backoff-curve math; the spec's own retryable/non-retryable classification table; a genuine retry-then-succeed run (2 failures, backoff, success on the 3rd real attempt); a genuine retry-exhaustion → DLQ → manual reprocess → recovery cycle; a non-retryable error bypassing the whole mechanism entirely (never retried, never queued); and a full `Closed → Open → (fails fast, `run` never called) → HalfOpen → Closed` circuit cycle against real elapsed wall-clock time.

## Adoption

Same phased approach as every standard in this queue. None of this codebase's real external integrations — `services/gateways/StripeGatewayAdapter.js`, the Amadeus GDS adapters, `EmailPlatformService`/`SmsPlatformService`, `CurrencyService`'s rate providers — are wired onto this engine in this pass. That is real, deliberate, separate follow-up work, one integration at a time (each needs its own decision about what `payload` a DLQ replay actually needs to carry).
