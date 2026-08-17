import { AsyncLocalStorage } from "node:async_hooks";

// Enterprise Architecture Hardening Phase — Correlation & Traceability
// Standard (Improvement 5). "Preserve the same Correlation-ID across all
// internal services... Include Correlation-ID in every log entry... every
// audit record... every domain event." Threading a correlationId through
// every function signature across this entire codebase (every service
// method, every publishEvent call, every logger call) would be exactly
// the kind of full, all-module retrofit this hardening phase's own
// established approach explicitly defers.
//
// `AsyncLocalStorage` is the real, standard Node.js primitive for this —
// the same underlying mechanism OpenTelemetry's own Node SDK uses for
// context propagation (the spec's own "Future support: OpenTelemetry...
// Correlation ID becomes the trace root" line). `middleware/requestContext.js`
// opens one store per incoming request; everything that runs inside that
// request's async call chain (controllers, services, `publishEvent`,
// every `logger.*` call, `AuditLogModel.create`'s own default) can read
// the current correlationId back with zero parameters threaded through
// any of them — real, automatic propagation, not a documented intention.
const correlationStorage = new AsyncLocalStorage();

/** Runs `fn` with `correlationId` available to `getCorrelationId()` anywhere in its async call chain. Called once per request by `middleware/requestContext.js`. */
export const runWithCorrelationId = (correlationId, fn) => correlationStorage.run({ correlationId }, fn);

/** Returns the current request's correlationId, or `null` outside any request context (e.g. a cron scheduler) — never fabricated. */
export const getCorrelationId = () => correlationStorage.getStore()?.correlationId || null;

export default { runWithCorrelationId, getCorrelationId };
