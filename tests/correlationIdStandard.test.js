import test, { after } from "node:test";
import assert from "node:assert/strict";
import dotenv from "dotenv";
import mongoose from "mongoose";
import Transport from "winston-transport";
import requestContext from "../middleware/requestContext.js";
import { runWithCorrelationId, getCorrelationId } from "../utils/correlationContext.js";
import { publishEvent, subscribeEvent } from "../utils/eventBus.js";
import logger from "../utils/logger.js";

dotenv.config();

// Enterprise Architecture Hardening Phase — Correlation & Traceability
// Standard (Improvement 5). Proves the real, automatic, zero-touch
// propagation: a request's correlationId reaches every log line, every
// published domain event, and every audit record's default `requestId`
// without a single parameter threaded through any controller/service —
// via Node's AsyncLocalStorage, not a documented intention.
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

const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

test("AsyncLocalStorage: getCorrelationId resolves through nested async calls, stays isolated across concurrent contexts, and is null outside any", async () => {
  const results = [];
  await Promise.all([
    runWithCorrelationId("corr-A", async () => {
      await new Promise((resolve) => setTimeout(resolve, 15));
      results.push(["A", getCorrelationId()]);
    }),
    runWithCorrelationId("corr-B", async () => {
      results.push(["B", getCorrelationId()]);
    })
  ]);
  assert.deepEqual(results.find((r) => r[0] === "A"), ["A", "corr-A"]);
  assert.deepEqual(results.find((r) => r[0] === "B"), ["B", "corr-B"]);
  assert.equal(getCorrelationId(), null, "outside any context, resolves to null, never fabricated");
});

test("requestContext middleware: Correlation-ID header wins over X-Request-ID, both response headers are set, and next() runs inside the async context", () => {
  const headers1 = {};
  const res1 = { setHeader: (k, v) => { headers1[k] = v; } };
  let sawInsideNext = null;
  const req1 = { header: (n) => (n === "Correlation-ID" ? "client-corr-1" : n === "X-Request-ID" ? "client-req-1" : null) };
  requestContext(req1, res1, () => { sawInsideNext = getCorrelationId(); });

  assert.equal(req1.requestId, "client-corr-1", "Correlation-ID header takes precedence over X-Request-ID");
  assert.equal(req1.correlationId, "client-corr-1");
  assert.equal(headers1["Correlation-ID"], "client-corr-1");
  assert.equal(headers1["X-Request-ID"], "client-corr-1", "both header names are returned with the SAME value");
  assert.equal(sawInsideNext, "client-corr-1", "the rest of the request pipeline runs inside the ALS context automatically");
});

test("requestContext middleware: falls back to X-Request-ID, generates a real UUID v4 when the client sends neither", () => {
  const req2 = { header: (n) => (n === "X-Request-ID" ? "legacy-req-2" : null) };
  requestContext(req2, { setHeader: () => {} }, () => {});
  assert.equal(req2.requestId, "legacy-req-2");

  const req3 = { header: () => null };
  requestContext(req3, { setHeader: () => {} }, () => {});
  assert.ok(UUID_V4_PATTERN.test(req3.requestId), "generates a real UUID v4 when neither header is present");
});

test("publishEvent auto-attaches the ambient request's correlationId; an explicit payload.correlationId always wins; no context -> honestly null", async () => {
  let received = null;
  subscribeEvent("CorrelationStandardTestEvent", (payload) => { received = payload; });
  const waitForDispatch = () => new Promise((resolve) => setTimeout(resolve, 30));

  await runWithCorrelationId("corr-auto", async () => {
    publishEvent("CorrelationStandardTestEvent", { foo: "bar" });
    await waitForDispatch();
  });
  assert.equal(received.correlationId, "corr-auto", "no correlationId passed -> falls back to the ambient request's own id");

  received = null;
  await runWithCorrelationId("corr-ambient", async () => {
    publishEvent("CorrelationStandardTestEvent", { foo: "baz", correlationId: "corr-explicit" });
    await waitForDispatch();
  });
  assert.equal(received.correlationId, "corr-explicit", "an explicitly-supplied correlationId always wins over the ambient one");

  received = null;
  publishEvent("CorrelationStandardTestEvent", { foo: "qux" });
  await waitForDispatch();
  assert.equal(received.correlationId, null, "outside any request context (e.g. a scheduler), honestly null, never fabricated");
});

test("logger: correlationId is automatically stamped from the ambient request context; an explicit one in the log call still wins", async () => {
  const captured = [];
  class CaptureTransport extends Transport {
    log(info, callback) {
      captured.push(info);
      callback();
    }
  }
  const transport = new CaptureTransport();
  logger.add(transport);
  try {
    runWithCorrelationId("corr-log-test", () => {
      logger.info("correlation-standard-test: ambient stamping");
    });
    runWithCorrelationId("corr-ambient-2", () => {
      logger.info("correlation-standard-test: explicit wins", { correlationId: "corr-explicit-2" });
    });
    logger.info("correlation-standard-test: no context at all");
    await new Promise((resolve) => setTimeout(resolve, 30));
  } finally {
    logger.remove(transport);
  }

  const ambientEntry = captured.find((e) => e.message === "correlation-standard-test: ambient stamping");
  assert.ok(ambientEntry);
  assert.equal(ambientEntry.correlationId, "corr-log-test");

  const explicitEntry = captured.find((e) => e.message === "correlation-standard-test: explicit wins");
  assert.ok(explicitEntry);
  assert.equal(explicitEntry.correlationId, "corr-explicit-2", "a call site's own explicit correlationId is never overwritten");

  const noContextEntry = captured.find((e) => e.message === "correlation-standard-test: no context at all");
  assert.ok(noContextEntry);
  assert.equal(noContextEntry.correlationId, undefined, "no ambient context and no explicit value -> no fabricated correlationId key");
});

test("AuditLogModel: requestId defaults to the real ambient correlationId when omitted, and to the honest system- placeholder outside any request context", { skip: !dbAvailable && dbSkipReason }, async (t) => {
  const AuditLogModel = (await import("../models/AuditLogmodel.js")).default;
  t.after(async () => {
    await AuditLogModel.deleteMany({ action: "correlation-standard-test" });
  });

  const createdInsideContext = await runWithCorrelationId("corr-audit-default", () =>
    AuditLogModel.create({ action: "correlation-standard-test" })
  );
  assert.equal(createdInsideContext.requestId, "corr-audit-default", "the audit record's own default resolves the real ambient correlationId, not a placeholder");

  const createdOutsideContext = await AuditLogModel.create({ action: "correlation-standard-test" });
  assert.ok(createdOutsideContext.requestId.startsWith("system-"), "outside any request context, the honest system- fallback is used, never a fabricated correlation id");

  const createdWithExplicit = await AuditLogModel.create({ action: "correlation-standard-test", requestId: "explicit-caller-id" });
  assert.equal(createdWithExplicit.requestId, "explicit-caller-id", "a caller that already supplies its own requestId is never overridden");
});

after(async () => {
  if (dbAvailable) await mongoose.disconnect();
});
