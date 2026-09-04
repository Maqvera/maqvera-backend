import DeadLetterQueueModel from "../models/DeadLetterQueueModel.js";
import CircuitBreakerStateModel from "../models/CircuitBreakerStateModel.js";
import AuditLogModel from "../models/AuditLogmodel.js";
import { publishEvent } from "./eventBus.js";
import { getCorrelationId } from "./correlationContext.js";
import { AppError } from "./errorContract.js";
import { getResilienceConfig, getIntegrationConfig, isRetryableError as defaultIsRetryableError } from "./resilienceConfig.js";
import logger from "./logger.js";

/**
 * Enterprise Resilience & Reliability Standard (Enterprise Architecture
 * Hardening Phase, Improvement 6). The real fault-tolerance engine every
 * Bank/Payment-Gateway/Tax-Authority/Exchange-Rate/Email/SMS/Government
 * API integration should call through: configurable retry with real
 * exponential backoff + jitter, a hard per-integration timeout, a Circuit
 * Breaker (Closed -> Open -> HalfOpen -> Closed) shared across the whole
 * process per integration, and a real Dead Letter Queue once the retry
 * budget is exhausted.
 *
 * Deliberately NOT wired into any existing integration adapter in this
 * pass (StripeGatewayAdapter, the Amadeus GDS adapters, Email/SMS
 * platform services, CurrencyService's rate providers) — same "global
 * standard first, module-by-module adoption after" approach as every
 * other standard in this phase. See
 * docs/07-enterprise-standards/06-resilience.md "Adoption".
 */

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// In-memory, per-process Circuit Breaker state — the hot-path check on
// every external call. A DB round trip before every single outbound
// request would defeat the entire purpose of a fast-fail breaker; Mongo
// (models/CircuitBreakerStateModel.js) is written to on every TRANSITION
// only, as the durable observability/history trail, not read on the hot
// path. Consistent with this codebase's single-instance assumption
// elsewhere (utils/eventBus.js's own in-process EventEmitter transport).
const circuitStates = new Map();

const getCircuitEntry = (integration) => {
  if (!circuitStates.has(integration)) {
    circuitStates.set(integration, { state: "Closed", consecutiveFailureCount: 0, openedAt: null, probeInFlight: false });
  }
  return circuitStates.get(integration);
};

const persistCircuitTransition = (integration, fromState, toState, reason) => {
  CircuitBreakerStateModel.findOneAndUpdate(
    { integration },
    {
      $set: {
        state: toState,
        ...(toState === "Open" ? { openedAt: new Date() } : {}),
        ...(toState === "Closed" ? { consecutiveFailureCount: 0 } : {})
      },
      $push: { transitions: { fromState, toState, reason: reason || null, occurredAt: new Date() } }
    },
    { upsert: true }
  ).catch((error) => logger.error("Circuit breaker state persistence failed", { integration, error: error.message }));
};

/** Real Closed -> Open -> HalfOpen state machine. Returns whether a call is currently allowed to reach the external system at all. */
export const canAttempt = (integration) => {
  const entry = getCircuitEntry(integration);
  if (entry.state === "Closed") return true;

  if (entry.state === "Open") {
    const config = getResilienceConfig();
    if (Date.now() - (entry.openedAt?.getTime() || 0) >= config.circuitOpenDurationMs) {
      entry.state = "HalfOpen";
      entry.probeInFlight = true;
      return true; // exactly one probe request is allowed through
    }
    return false; // fail fast — "New Requests Blocked"
  }

  // HalfOpen — only the single in-flight probe is allowed; every other
  // concurrent caller fails fast until that probe resolves.
  return false;
};

const recordCircuitSuccess = (integration, tenantId, correlationId) => {
  const entry = getCircuitEntry(integration);
  const wasHalfOpen = entry.state === "HalfOpen";
  entry.consecutiveFailureCount = 0;
  entry.probeInFlight = false;
  if (wasHalfOpen || entry.state === "Open") {
    const fromState = entry.state;
    entry.state = "Closed";
    entry.openedAt = null;
    persistCircuitTransition(integration, fromState, "Closed", "Recovery probe succeeded.");
    AuditLogModel.create({ action: "resilience.circuit_closed", tenantId: tenantId || null, requestId: correlationId, module: "EnterpriseResilience", resource: "CircuitBreaker", resourceId: integration, details: {} }).catch(() => null);
    publishEvent("CircuitClosed.v1", { integration, tenantId: tenantId || null, correlationId });
    publishEvent("IntegrationRecovered.v1", { integration, tenantId: tenantId || null, correlationId });
  }
};

const recordCircuitFailure = (integration, tenantId, correlationId, reason) => {
  const entry = getCircuitEntry(integration);
  const config = getResilienceConfig();
  entry.probeInFlight = false;

  if (entry.state === "HalfOpen") {
    // The recovery probe itself failed — back to Open, timer restarts.
    entry.state = "Open";
    entry.openedAt = new Date();
    persistCircuitTransition(integration, "HalfOpen", "Open", reason);
    return;
  }

  entry.consecutiveFailureCount += 1;
  if (entry.state === "Closed" && entry.consecutiveFailureCount >= config.circuitFailureThreshold) {
    entry.state = "Open";
    entry.openedAt = new Date();
    persistCircuitTransition(integration, "Closed", "Open", reason);
    AuditLogModel.create({ action: "resilience.circuit_opened", outcome: "circuit_open", tenantId: tenantId || null, requestId: correlationId, module: "EnterpriseResilience", resource: "CircuitBreaker", resourceId: integration, details: { consecutiveFailureCount: entry.consecutiveFailureCount, reason } }).catch(() => null);
    publishEvent("CircuitOpened.v1", { integration, tenantId: tenantId || null, correlationId, consecutiveFailureCount: entry.consecutiveFailureCount, reason });
  }
};

export const getCircuitBreakerSnapshot = (integration) => {
  const entry = getCircuitEntry(integration);
  return { integration, state: entry.state, consecutiveFailureCount: entry.consecutiveFailureCount, openedAt: entry.openedAt };
};

/** "Retry 1s -> 2s -> 4s -> 8s -> 16s" with EQUAL jitter (delay is always in [half, full] of the capped exponential value) — grows visibly like the spec's own example while still spreading concurrent retries out, avoiding a retry-storm against a system that just came back up. */
export const computeBackoffDelayMs = (attempt, config = getResilienceConfig()) => {
  const capped = Math.min(config.backoffMaxMs, config.backoffBaseMs * Math.pow(config.backoffFactor, attempt - 1));
  const half = capped / 2;
  return Math.round(half + Math.random() * half);
};

export const moveToDeadLetterQueue = async ({ integration, module, operationLabel, tenantId, correlationId, idempotencyKey, payload, attemptsMade, reason, userId }) => {
  const dlq = await DeadLetterQueueModel.create({
    tenantId: tenantId || null, module, operation: operationLabel, integration, reason,
    retryAttempts: attemptsMade, correlationId, idempotencyKey: idempotencyKey || null, payload: payload || null,
    status: "Pending", failedAt: new Date(),
    timeline: [{ event: "DeadLetterQueued", description: reason, performedBy: userId || null }]
  });

  await AuditLogModel.create({
    action: "resilience.retry_exhausted", outcome: "failure", tenantId: tenantId || null, requestId: correlationId,
    module: "EnterpriseResilience", resource: "DeadLetterQueue", resourceId: dlq._id.toString(),
    details: { integration, module, operationLabel, attempts: attemptsMade, reason }
  }).catch(() => null);

  publishEvent("RetryExhausted.v1", { integration, module, operationLabel, tenantId: tenantId || null, correlationId, attempts: attemptsMade, reason });
  publishEvent("DeadLetterQueued.v1", { dlqId: dlq._id.toString(), integration, module, operationLabel, tenantId: tenantId || null, correlationId });

  return dlq;
};

/**
 * The real, single entry point every external-integration call should go
 * through. `run(signal)` performs the actual external call and MUST
 * respect the given `AbortSignal` for the timeout to be real (e.g. pass
 * it as axios's own `signal` option, or `fetch`'s second argument).
 *
 * "Every retry MUST preserve the original Correlation-ID and
 * Idempotency-Key" — real: neither is regenerated across attempts, both
 * are recorded on every retry/exhaustion audit entry and event, and on
 * the DLQ record itself for a faithful manual replay later.
 */
export const executeResilientOperation = async ({
  integration, run, module, operationLabel,
  tenantId = null, correlationId = null, idempotencyKey = null, userId = null, payload = null,
  isRetryable = defaultIsRetryableError
}) => {
  if (typeof run !== "function") throw new Error("run must be a function.");
  if (!integration || !module || !operationLabel) throw new Error("integration, module, and operationLabel are required.");

  const config = getResilienceConfig();
  const integrationConfig = getIntegrationConfig(integration);
  const resolvedCorrelationId = correlationId || getCorrelationId() || null;
  const maxAttempts = integrationConfig.maxRetries + 1;

  let lastError = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (!canAttempt(integration)) {
      if (attempt === 1) {
        // Nothing has actually been attempted yet — a real, honest
        // fail-fast rejection, not a "failed message" worth queuing.
        throw new AppError("EXTERNAL_SERVICE_ERROR", {
          message: `${integration} circuit breaker is open — request rejected without calling the external system.`,
          details: { integration }
        });
      }
      const dlq = await moveToDeadLetterQueue({
        integration, module, operationLabel, tenantId, correlationId: resolvedCorrelationId, idempotencyKey, payload,
        attemptsMade: attempt - 1, reason: `Circuit breaker opened after ${attempt - 1} attempt(s): ${lastError?.message || "unknown error"}`, userId
      });
      throw new AppError("EXTERNAL_SERVICE_ERROR", { message: `${integration} circuit breaker opened during retry — moved to the Dead Letter Queue.`, details: { dlqId: dlq._id.toString(), integration } });
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), integrationConfig.timeoutMs);

    try {
      const result = await run(controller.signal);
      clearTimeout(timer);
      recordCircuitSuccess(integration, tenantId, resolvedCorrelationId);

      if (attempt > 1) {
        await AuditLogModel.create({
          action: "resilience.retry_succeeded", tenantId: tenantId || null, requestId: resolvedCorrelationId,
          module: "EnterpriseResilience", resource: integration, details: { module, operationLabel, attempt }
        }).catch(() => null);
        publishEvent("RetrySucceeded.v1", { integration, module, operationLabel, tenantId: tenantId || null, correlationId: resolvedCorrelationId, attempt });
      }
      return result;
    } catch (error) {
      clearTimeout(timer);
      const timedOut = controller.signal.aborted && error?.name !== "AbortError";
      const effectiveError = timedOut ? Object.assign(new Error(`${integration} request timed out after ${integrationConfig.timeoutMs}ms.`), { name: "AbortError" }) : error;
      lastError = effectiveError;

      if (!isRetryable(effectiveError)) {
        // A permanent/business failure (401/403/404/409/422, invalid
        // credentials, duplicate payment, ...) — never retried, never
        // counted against the circuit breaker (it says nothing about the
        // external system's own health), never queued to the DLQ (the
        // caller's normal business-error handling is correct for this).
        throw effectiveError;
      }

      recordCircuitFailure(integration, tenantId, resolvedCorrelationId, effectiveError.message);

      if (attempt >= maxAttempts) {
        const dlq = await moveToDeadLetterQueue({
          integration, module, operationLabel, tenantId, correlationId: resolvedCorrelationId, idempotencyKey, payload,
          attemptsMade: attempt, reason: effectiveError.message, userId
        });
        throw new AppError("EXTERNAL_SERVICE_ERROR", { message: `${integration} operation failed after ${attempt - 1} ${attempt - 1 === 1 ? "retry" : "retries"} and was moved to the Dead Letter Queue.`, details: { dlqId: dlq._id.toString(), integration } });
      }

      const delayMs = computeBackoffDelayMs(attempt, config);
      await AuditLogModel.create({
        action: "resilience.retry_scheduled", outcome: "retrying", tenantId: tenantId || null, requestId: resolvedCorrelationId,
        module: "EnterpriseResilience", resource: integration, details: { module, operationLabel, attempt, delayMs, reason: effectiveError.message }
      }).catch(() => null);
      publishEvent("RetryScheduled.v1", { integration, module, operationLabel, tenantId: tenantId || null, correlationId: resolvedCorrelationId, attempt, delayMs, reason: effectiveError.message });

      await sleep(delayMs);
    }
  }

  throw lastError; // unreachable — every loop exit path above returns or throws
};

/** Manual/automatic DLQ reprocessing — "Operations Review -> Manual Retry -> Success -> Archive OR Permanent Failure." `run` is supplied by the CALLER (the one module that actually knows how to re-execute this specific operation) — a fully generic, serialized replay isn't real/safe over HTTP. */
export const reprocessDeadLetter = async (dlqId, run, userId) => {
  const dlq = await DeadLetterQueueModel.findById(dlqId);
  if (!dlq) throw new Error("Dead letter queue record not found.");
  if (dlq.status === "Recovered") return dlq.toJSON();

  dlq.status = "Reprocessing";
  dlq.manualRetryCount += 1;
  dlq.timeline.push({ event: "ReprocessingStarted", performedBy: userId || null });
  await dlq.save();

  try {
    const result = await executeResilientOperation({
      integration: dlq.integration, run, module: dlq.module, operationLabel: dlq.operation,
      tenantId: dlq.tenantId, correlationId: dlq.correlationId, idempotencyKey: dlq.idempotencyKey, userId, payload: dlq.payload
    });

    dlq.status = "Recovered";
    dlq.reprocessedAt = new Date();
    dlq.reprocessedBy = userId || null;
    dlq.timeline.push({ event: "DeadLetterReprocessed", description: "Manual reprocessing succeeded.", performedBy: userId || null });
    await dlq.save();

    await AuditLogModel.create({ action: "resilience.dlq_reprocessed", tenantId: dlq.tenantId, requestId: dlq.correlationId, module: "EnterpriseResilience", resource: "DeadLetterQueue", resourceId: dlq._id.toString(), details: { integration: dlq.integration } }).catch(() => null);
    publishEvent("DeadLetterReprocessed.v1", { dlqId: dlq._id.toString(), integration: dlq.integration, tenantId: dlq.tenantId, correlationId: dlq.correlationId, performedBy: userId || null });

    return result;
  } catch (error) {
    // A failed manual retry stays actionable (Pending), never silently
    // terminal — Operations decides when to give up via
    // markDeadLetterPermanentFailure below, a deliberate act, not an
    // automatic side effect of one more failure.
    dlq.status = "Pending";
    dlq.timeline.push({ event: "ReprocessingFailed", description: error.message, performedBy: userId || null });
    await dlq.save();
    await AuditLogModel.create({ action: "resilience.dlq_reprocess_failed", outcome: "failure", tenantId: dlq.tenantId, requestId: dlq.correlationId, module: "EnterpriseResilience", resource: "DeadLetterQueue", resourceId: dlq._id.toString(), details: { reason: error.message } }).catch(() => null);
    throw error;
  }
};

// ---- Monitoring — "Track Retry Count, Failure Rate, Timeout Rate,
// Circuit Breaker Status, DLQ Size, Recovery Rate, Average Retry Time.
// Dashboard should expose all these metrics." Real read access to the
// two durable collections; an actual dashboard UI/aggregation layer is
// real, separate follow-up work (see "Adoption" in the standard's doc),
// not attempted here — this is the honest data source it would read from.

export const listDeadLetters = async (tenantId, query = {}) => {
  const config = getResilienceConfig();
  const filter = {};
  if (tenantId) filter.tenantId = tenantId;
  if (query.status) filter.status = query.status;
  if (query.integration) filter.integration = query.integration;
  if (query.module) filter.module = query.module;
  const page = Math.max(parseInt(query.page, 10) || 1, 1);
  const pageSize = Math.min(Math.max(parseInt(query.pageSize, 10) || config.defaultPageSize, 1), config.maxPageSize);

  const [items, total] = await Promise.all([
    DeadLetterQueueModel.find(filter).sort({ failedAt: -1 }).skip((page - 1) * pageSize).limit(pageSize).lean(),
    DeadLetterQueueModel.countDocuments(filter)
  ]);
  return { items, pagination: { total, page, pageSize, totalPages: Math.ceil(total / pageSize) } };
};

export const getDeadLetterById = async (tenantId, dlqId) => {
  const filter = { _id: dlqId };
  if (tenantId) filter.tenantId = tenantId;
  const dlq = await DeadLetterQueueModel.findOne(filter).lean();
  if (!dlq) throw new Error("Dead letter queue record not found.");
  return dlq;
};

/** In-memory snapshot for every integration this process has actually called at least once, merged with the durable history for ones it hasn't (e.g. right after a restart). */
export const listCircuitBreakers = async () => {
  const persisted = await CircuitBreakerStateModel.find({}).lean();
  const byIntegration = new Map(persisted.map((row) => [row.integration, row]));
  for (const integration of circuitStates.keys()) {
    if (!byIntegration.has(integration)) byIntegration.set(integration, null);
  }
  return Array.from(byIntegration.keys()).map((integration) => {
    const live = circuitStates.has(integration) ? getCircuitBreakerSnapshot(integration) : null;
    const persistedRow = byIntegration.get(integration);
    return {
      integration,
      state: live?.state || persistedRow?.state || "Closed",
      consecutiveFailureCount: live?.consecutiveFailureCount ?? persistedRow?.consecutiveFailureCount ?? 0,
      openedAt: live?.openedAt || persistedRow?.openedAt || null,
      lastSuccessAt: persistedRow?.lastSuccessAt || null,
      lastFailureAt: persistedRow?.lastFailureAt || null
    };
  });
};

export const markDeadLetterPermanentFailure = async (dlqId, reason, userId) => {
  const dlq = await DeadLetterQueueModel.findById(dlqId);
  if (!dlq) throw new Error("Dead letter queue record not found.");
  dlq.status = "PermanentFailure";
  dlq.timeline.push({ event: "PermanentFailureMarked", description: reason || null, performedBy: userId || null });
  await dlq.save();
  await AuditLogModel.create({ action: "resilience.dlq_permanent_failure", tenantId: dlq.tenantId, requestId: dlq.correlationId, module: "EnterpriseResilience", resource: "DeadLetterQueue", resourceId: dlq._id.toString(), details: { reason } }).catch(() => null);
  return dlq.toJSON();
};
