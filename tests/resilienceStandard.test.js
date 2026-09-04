import test, { after } from "node:test";
import assert from "node:assert/strict";
import dotenv from "dotenv";
import mongoose from "mongoose";
import { computeBackoffDelayMs } from "../utils/resilienceEngine.js";
import { isRetryableError } from "../utils/resilienceConfig.js";

dotenv.config();

// Enterprise Architecture Hardening Phase — Resilience & Reliability
// Standard (Improvement 6). Proves the real fault-tolerance engine end to
// end against a real database: retry-then-succeed, retry exhaustion ->
// real Dead Letter Queue row -> manual reprocessing -> recovery,
// non-retryable errors bypassing the whole mechanism, and a real
// Closed -> Open -> HalfOpen -> Closed circuit breaker cycle.
let dbAvailable = false;
const uri = process.env.URI || process.env.MONGO_URI;
if (uri) {
  try {
    await mongoose.connect(uri, { serverSelectionTimeoutMS: 8000 });
    dbAvailable = mongoose.connection.readyState === 1;
  } catch {
    dbAvailable = false;
  }
}
const dbSkipReason = "No reachable MongoDB configured (set URI in .env) — skipping live integration test.";

test("computeBackoffDelayMs grows exponentially, stays capped, and jitters within [half, full] of the capped value", () => {
  const config = { backoffBaseMs: 1000, backoffFactor: 2, backoffMaxMs: 30000, backoffJitterRatio: 0.5 };
  for (let attempt = 1; attempt <= 6; attempt++) {
    const capped = Math.min(config.backoffMaxMs, config.backoffBaseMs * Math.pow(config.backoffFactor, attempt - 1));
    for (let i = 0; i < 20; i++) {
      const delay = computeBackoffDelayMs(attempt, config);
      assert.ok(delay >= capped / 2, `attempt ${attempt}: delay ${delay} must be >= half of capped ${capped}`);
      assert.ok(delay <= capped, `attempt ${attempt}: delay ${delay} must never exceed capped ${capped}`);
    }
  }
  // Attempt 6 (base 1000 * 2^5 = 32000) must be clamped to backoffMaxMs (30000).
  const delayAt6 = computeBackoffDelayMs(6, config);
  assert.ok(delayAt6 <= 30000);
});

test("isRetryableError classifies per the spec's own Retryable/Non-Retryable tables", () => {
  assert.equal(isRetryableError({ response: { status: 500 } }), true);
  assert.equal(isRetryableError({ response: { status: 502 } }), true);
  assert.equal(isRetryableError({ response: { status: 503 } }), true);
  assert.equal(isRetryableError({ response: { status: 504 } }), true);
  assert.equal(isRetryableError({ httpStatus: 401 }), false);
  assert.equal(isRetryableError({ httpStatus: 403 }), false);
  assert.equal(isRetryableError({ httpStatus: 404 }), false);
  assert.equal(isRetryableError({ httpStatus: 409 }), false);
  assert.equal(isRetryableError({ httpStatus: 422 }), false);
  assert.equal(isRetryableError({ name: "AbortError" }), true, "our own timeout abort is retryable");
  assert.equal(isRetryableError({ code: "ECONNRESET" }), true);
  assert.equal(isRetryableError({ code: "ETIMEDOUT" }), true);
  assert.equal(isRetryableError({ message: "totally unclassified" }), false, "the safe default for anything unrecognized is non-retryable");
});

test("executeResilientOperation: real retry-then-succeed preserves correlationId/idempotencyKey and fires the real events", { skip: !dbAvailable && dbSkipReason }, async (t) => {
  const { executeResilientOperation } = await import("../utils/resilienceEngine.js");
  const { subscribeEvent } = await import("../utils/eventBus.js");
  const AuditLogModel = (await import("../models/AuditLogmodel.js")).default;

  const integration = `TestIntegration-${Date.now()}`;
  process.env.RESILIENCE_INTEGRATIONS_JSON = JSON.stringify({ [integration]: { timeoutMs: 2000, maxRetries: 3 } });
  process.env.RESILIENCE_BACKOFF_BASE_MS = "20";
  process.env.RESILIENCE_BACKOFF_MAX_MS = "40";
  t.after(() => {
    delete process.env.RESILIENCE_INTEGRATIONS_JSON;
    delete process.env.RESILIENCE_BACKOFF_BASE_MS;
    delete process.env.RESILIENCE_BACKOFF_MAX_MS;
  });

  const scheduledEvents = [];
  const succeededEvents = [];
  subscribeEvent("RetryScheduled.v1", (p) => scheduledEvents.push(p));
  subscribeEvent("RetrySucceeded.v1", (p) => succeededEvents.push(p));

  const tenantId = `test-res-${Date.now()}`;
  const correlationId = `corr-${Date.now()}`;
  const idempotencyKey = "6b98cb82-4c9d-4e34-8b5f-12562f0d75ae";

  let callCount = 0;
  const result = await executeResilientOperation({
    integration, module: "Payments", operationLabel: "BankSync",
    tenantId, correlationId, idempotencyKey, payload: { amount: 1000 },
    run: async () => {
      callCount += 1;
      if (callCount < 3) {
        const err = new Error("Gateway Timeout");
        err.response = { status: 504 };
        throw err;
      }
      return { synced: true };
    }
  });

  assert.deepEqual(result, { synced: true });
  assert.equal(callCount, 3, "2 failures then a real success on the 3rd attempt");
  assert.equal(scheduledEvents.length, 2, "one RetryScheduled per failed attempt before success");
  assert.equal(scheduledEvents[0].correlationId, correlationId, "correlationId is preserved across every retry");
  assert.equal(succeededEvents.length, 1);
  assert.equal(succeededEvents[0].attempt, 3);

  await new Promise((resolve) => setTimeout(resolve, 50));
  const auditActions = (await AuditLogModel.find({ requestId: correlationId }).sort({ createdAt: 1 }).lean()).map((a) => a.action);
  assert.deepEqual(auditActions, ["resilience.retry_scheduled", "resilience.retry_scheduled", "resilience.retry_succeeded"]);
});

test("executeResilientOperation: retry exhaustion moves the message to a real Dead Letter Queue, then reprocessDeadLetter recovers it", { skip: !dbAvailable && dbSkipReason }, async (t) => {
  const { executeResilientOperation, reprocessDeadLetter } = await import("../utils/resilienceEngine.js");
  const { subscribeEvent } = await import("../utils/eventBus.js");
  const DeadLetterQueueModel = (await import("../models/DeadLetterQueueModel.js")).default;

  const integration = `TestIntegrationExhaust-${Date.now()}`;
  process.env.RESILIENCE_INTEGRATIONS_JSON = JSON.stringify({ [integration]: { timeoutMs: 2000, maxRetries: 2 } });
  process.env.RESILIENCE_BACKOFF_BASE_MS = "10";
  process.env.RESILIENCE_BACKOFF_MAX_MS = "20";
  process.env.RESILIENCE_CIRCUIT_FAILURE_THRESHOLD = "100"; // keep the circuit closed for this test
  t.after(() => {
    delete process.env.RESILIENCE_INTEGRATIONS_JSON;
    delete process.env.RESILIENCE_BACKOFF_BASE_MS;
    delete process.env.RESILIENCE_BACKOFF_MAX_MS;
    delete process.env.RESILIENCE_CIRCUIT_FAILURE_THRESHOLD;
  });

  const exhaustedEvents = [];
  const dlqEvents = [];
  subscribeEvent("RetryExhausted.v1", (p) => exhaustedEvents.push(p));
  subscribeEvent("DeadLetterQueued.v1", (p) => dlqEvents.push(p));

  const tenantId = `test-res-${Date.now()}`;
  const correlationId = `corr-${Date.now()}`;

  const alwaysFail = async () => {
    const err = new Error("Service Unavailable");
    err.response = { status: 503 };
    throw err;
  };

  await assert.rejects(
    () => executeResilientOperation({ integration, module: "Payments", operationLabel: "BankSync", tenantId, correlationId, payload: { amount: 500 }, run: alwaysFail }),
    /Dead Letter Queue/
  );

  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(exhaustedEvents.length, 1);
  assert.equal(exhaustedEvents[0].attempts, 3, "maxRetries: 2 -> 3 total real attempts");
  assert.equal(dlqEvents.length, 1);

  const dlqId = dlqEvents[0].dlqId;
  const dlqRow = await DeadLetterQueueModel.findById(dlqId).lean();
  assert.equal(dlqRow.status, "Pending");
  assert.equal(dlqRow.correlationId, correlationId);
  assert.equal(dlqRow.retryAttempts, 3);
  assert.deepEqual(dlqRow.payload, { amount: 500 });

  const recovered = await reprocessDeadLetter(dlqId, async () => ({ synced: true }), "ops-user");
  assert.deepEqual(recovered, { synced: true });
  const reloaded = await DeadLetterQueueModel.findById(dlqId).lean();
  assert.equal(reloaded.status, "Recovered");
  assert.ok(reloaded.reprocessedAt);
  assert.equal(reloaded.reprocessedBy, "ops-user");
});

test("executeResilientOperation: a non-retryable error is thrown immediately — no retries, no DLQ", { skip: !dbAvailable && dbSkipReason }, async (t) => {
  const { executeResilientOperation } = await import("../utils/resilienceEngine.js");
  const DeadLetterQueueModel = (await import("../models/DeadLetterQueueModel.js")).default;

  const integration = `TestIntegrationNonRetryable-${Date.now()}`;
  process.env.RESILIENCE_INTEGRATIONS_JSON = JSON.stringify({ [integration]: { timeoutMs: 2000, maxRetries: 5 } });
  t.after(() => { delete process.env.RESILIENCE_INTEGRATIONS_JSON; });

  let callCount = 0;
  await assert.rejects(
    () => executeResilientOperation({
      integration, module: "Payments", operationLabel: "BankSync",
      run: async () => {
        callCount += 1;
        const err = new Error("Duplicate payment.");
        err.httpStatus = 409;
        throw err;
      }
    }),
    /Duplicate payment/
  );
  assert.equal(callCount, 1, "a non-retryable failure must never be retried");

  const dlqCount = await DeadLetterQueueModel.countDocuments({ module: "Payments", operation: "BankSync", integration });
  assert.equal(dlqCount, 0, "a non-retryable failure must never reach the Dead Letter Queue");
});

test("Circuit Breaker: Closed -> Open after threshold failures -> fails fast -> HalfOpen after cooldown -> Closed on a successful probe", { skip: !dbAvailable && dbSkipReason }, async (t) => {
  const { executeResilientOperation, getCircuitBreakerSnapshot } = await import("../utils/resilienceEngine.js");
  const { subscribeEvent } = await import("../utils/eventBus.js");
  const CircuitBreakerStateModel = (await import("../models/CircuitBreakerStateModel.js")).default;

  const integration = `TestIntegrationCircuit-${Date.now()}`;
  process.env.RESILIENCE_INTEGRATIONS_JSON = JSON.stringify({ [integration]: { timeoutMs: 2000, maxRetries: 0 } });
  process.env.RESILIENCE_CIRCUIT_FAILURE_THRESHOLD = "2";
  // Generous relative to real DB round-trip latency (DLQ + audit writes
  // between the circuit opening and this test's next assertion can
  // themselves take 100ms+ against a remote cluster) — this must stay
  // comfortably open when checked immediately, and comfortably expired
  // after the real wait below, not race either boundary.
  process.env.RESILIENCE_CIRCUIT_OPEN_DURATION_MS = "600";
  t.after(() => {
    delete process.env.RESILIENCE_INTEGRATIONS_JSON;
    delete process.env.RESILIENCE_CIRCUIT_FAILURE_THRESHOLD;
    delete process.env.RESILIENCE_CIRCUIT_OPEN_DURATION_MS;
  });

  const openedEvents = [];
  const closedEvents = [];
  subscribeEvent("CircuitOpened.v1", (p) => openedEvents.push(p));
  subscribeEvent("CircuitClosed.v1", (p) => closedEvents.push(p));

  const failOnce = async () => { const err = new Error("Bad Gateway"); err.response = { status: 502 }; throw err; };

  // maxRetries: 0 -> each call is exactly 1 real attempt. 2 failing calls should trip the threshold (2).
  await assert.rejects(() => executeResilientOperation({ integration, module: "Bank", operationLabel: "Ping", run: failOnce }));
  await assert.rejects(() => executeResilientOperation({ integration, module: "Bank", operationLabel: "Ping", run: failOnce }));

  assert.equal(getCircuitBreakerSnapshot(integration).state, "Open");
  assert.equal(openedEvents.length, 1);

  // While Open, a new call must fail fast WITHOUT ever invoking `run`.
  let ranWhileOpen = false;
  await assert.rejects(
    () => executeResilientOperation({ integration, module: "Bank", operationLabel: "Ping", run: async () => { ranWhileOpen = true; return "should not run"; } }),
    /circuit breaker is open/
  );
  assert.equal(ranWhileOpen, false, "the external system must never be called while the circuit is Open");

  await new Promise((resolve) => setTimeout(resolve, 700)); // past circuitOpenDurationMs

  const recovered = await executeResilientOperation({ integration, module: "Bank", operationLabel: "Ping", run: async () => "healthy again" });
  assert.equal(recovered, "healthy again");
  assert.equal(getCircuitBreakerSnapshot(integration).state, "Closed");
  assert.equal(closedEvents.length, 1);

  await new Promise((resolve) => setTimeout(resolve, 50));
  const persisted = await CircuitBreakerStateModel.findOne({ integration }).lean();
  assert.equal(persisted.state, "Closed");
  assert.ok(persisted.transitions.some((t) => t.toState === "Open"));
  assert.ok(persisted.transitions.some((t) => t.toState === "Closed"));
});

after(async () => {
  if (dbAvailable) await mongoose.disconnect();
});
