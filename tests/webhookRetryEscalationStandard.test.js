import test, { after } from "node:test";
import assert from "node:assert/strict";
import dotenv from "dotenv";
import mongoose from "mongoose";
import http from "node:http";

dotenv.config();

// Enterprise Architecture Hardening Phase — Enterprise Webhook Standard
// (Improvement 14). Proves the real, NEW long-horizon retry escalation
// this standard adds on top of the already-real webhook engine (creation,
// HMAC signing, immediate short-burst retry, replay — all pre-existing
// and covered by tests/webhookDeliveryIntegration.test.js, untouched
// here): a persistently-failing delivery escalates through
// webhookLongRetryScheduleSeconds's own tiers via WebhookService's real
// Retrying status + nextRetryAt, genuinely reaches a real Dead Letter
// Queue row (Improvement 6's own DeadLetterQueueModel, visible through
// the EXISTING resilience monitoring read path), a delivery whose
// subscription stopped being Active is honestly Abandoned rather than
// retried forever, a scheduled retry that succeeds genuinely recovers to
// Delivered, and the new monitoring summary aggregates real data.
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

const startFailingServer = async () => {
  const server = http.createServer((req, res) => {
    req.on("data", () => {});
    req.on("end", () => { res.writeHead(500, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "boom" })); });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, url: `http://127.0.0.1:${server.address().port}/webhook` };
};

const startOkServer = async () => {
  const server = http.createServer((req, res) => {
    req.on("data", () => {});
    req.on("end", () => { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ received: true })); });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, url: `http://127.0.0.1:${server.address().port}/webhook` };
};

test("deliverEvent: a persistently-failing endpoint escalates to Retrying with the FIRST long-horizon schedule tier, never straight to a terminal Failed/DLQ state", { skip: !dbAvailable && dbSkipReason }, async (t) => {
  const WebhookSubscriptionModel = (await import("../models/WebhookSubscriptionModel.js")).default;
  const WebhookDeliveryModel = (await import("../models/WebhookDeliveryModel.js")).default;
  const WebhookService = (await import("../services/WebhookService.js")).default;

  process.env.WEBHOOK_RETRY_MAX_ATTEMPTS = "1";
  process.env.WEBHOOK_RETRY_BASE_DELAY_MS = "10";
  process.env.WEBHOOK_LONG_RETRY_SCHEDULE_SECONDS_JSON = "[5,10,15]";

  const { server, url } = await startFailingServer();
  const tenantId = `test-webhook-escalate-${Date.now()}`;

  t.after(async () => {
    delete process.env.WEBHOOK_RETRY_MAX_ATTEMPTS;
    delete process.env.WEBHOOK_RETRY_BASE_DELAY_MS;
    delete process.env.WEBHOOK_LONG_RETRY_SCHEDULE_SECONDS_JSON;
    await WebhookSubscriptionModel.deleteMany({ tenantId });
    await WebhookDeliveryModel.deleteMany({ tenantId });
    await new Promise((resolve) => server.close(resolve));
  });

  const subscription = await WebhookService.createSubscription({ url, subscribedEvents: ["WebhookEscalationTestEvent"] }, tenantId, "tester");
  const beforeCall = Date.now();
  await WebhookService.deliverEvent("WebhookEscalationTestEvent", { tenantId, eventId: `evt-${Date.now()}`, occurredAt: new Date().toISOString() });

  const delivery = await WebhookDeliveryModel.findOne({ tenantId, webhookSubscriptionId: subscription._id }).lean();
  assert.equal(delivery.status, "Retrying", "the delivery must NOT be a terminal Failed/DeadLetterQueue state after only the immediate burst is exhausted");
  assert.equal(delivery.longRetryAttempt, 1, "exactly the first long-horizon tier has been consumed");
  assert.equal(delivery.attempts.length, 1, "webhookRetryMaxAttempts=1 -> exactly one real HTTP attempt in the immediate burst");
  assert.equal(delivery.attempts[0].succeeded, false);
  const expectedNextRetryAt = beforeCall + 5000;
  assert.ok(Math.abs(delivery.nextRetryAt.getTime() - expectedNextRetryAt) < 2000, `nextRetryAt should be ~5s out (first schedule tier), got ${delivery.nextRetryAt.getTime() - beforeCall}ms`);
});

test("processDueRetries: escalates a due Retrying delivery through every remaining tier, then genuinely reaches the Dead Letter Queue — visible through the existing resilience monitoring read path", { skip: !dbAvailable && dbSkipReason }, async (t) => {
  const WebhookSubscriptionModel = (await import("../models/WebhookSubscriptionModel.js")).default;
  const WebhookDeliveryModel = (await import("../models/WebhookDeliveryModel.js")).default;
  const DeadLetterQueueModel = (await import("../models/DeadLetterQueueModel.js")).default;
  const WebhookService = (await import("../services/WebhookService.js")).default;
  const { listDeadLetters } = await import("../utils/resilienceEngine.js");

  process.env.WEBHOOK_RETRY_MAX_ATTEMPTS = "1";
  process.env.WEBHOOK_RETRY_BASE_DELAY_MS = "10";
  process.env.WEBHOOK_LONG_RETRY_SCHEDULE_SECONDS_JSON = "[0,0]";

  const { server, url } = await startFailingServer();
  const tenantId = `test-webhook-dlq-${Date.now()}`;

  t.after(async () => {
    delete process.env.WEBHOOK_RETRY_MAX_ATTEMPTS;
    delete process.env.WEBHOOK_RETRY_BASE_DELAY_MS;
    delete process.env.WEBHOOK_LONG_RETRY_SCHEDULE_SECONDS_JSON;
    await WebhookSubscriptionModel.deleteMany({ tenantId });
    await WebhookDeliveryModel.deleteMany({ tenantId });
    await DeadLetterQueueModel.deleteMany({ tenantId });
    await new Promise((resolve) => server.close(resolve));
  });

  const subscription = await WebhookService.createSubscription({ url, subscribedEvents: ["WebhookDlqTestEvent"] }, tenantId, "tester");
  await WebhookService.deliverEvent("WebhookDlqTestEvent", { tenantId, eventId: `evt-${Date.now()}`, occurredAt: new Date().toISOString() });

  let delivery = await WebhookDeliveryModel.findOne({ tenantId }).lean();
  assert.equal(delivery.status, "Retrying");
  assert.equal(delivery.longRetryAttempt, 1);

  await new Promise((resolve) => setTimeout(resolve, 30)); // clear the 0s-out nextRetryAt window
  const processedTier2 = await WebhookService.processDueRetries();
  assert.ok(processedTier2 >= 1);
  delivery = await WebhookDeliveryModel.findOne({ tenantId }).lean();
  assert.equal(delivery.status, "Retrying", "one schedule tier ([0,0] has 2 entries) remains after the second failed attempt");
  assert.equal(delivery.longRetryAttempt, 2);

  await new Promise((resolve) => setTimeout(resolve, 30));
  const processedFinal = await WebhookService.processDueRetries();
  assert.ok(processedFinal >= 1);
  delivery = await WebhookDeliveryModel.findOne({ tenantId }).lean();
  assert.equal(delivery.status, "DeadLetterQueue", "the schedule is fully exhausted (2 of 2 tiers consumed) -> genuine DLQ hand-off");
  assert.ok(delivery.dlqId, "the delivery is linked to its real DeadLetterQueueModel row");

  const dlqRow = await DeadLetterQueueModel.findById(delivery.dlqId).lean();
  assert.ok(dlqRow, "a real DeadLetterQueueModel row exists — genuine reuse of Improvement 6's model, not a parallel one");
  assert.equal(dlqRow.module, "Webhook");
  assert.equal(dlqRow.integration, "Webhook");
  assert.equal(dlqRow.operation, "WebhookDlqTestEvent");
  assert.equal(dlqRow.status, "Pending");

  const { items } = await listDeadLetters(tenantId, { module: "Webhook" });
  assert.equal(items.length, 1, "the webhook DLQ row is visible through the EXISTING generic resilience DLQ read path — no second, parallel dashboard needed");
  assert.equal(String(items[0]._id), String(dlqRow._id));
});

test("processDueRetries: a Retrying delivery whose subscription is no longer Active is honestly Abandoned, never retried forever", { skip: !dbAvailable && dbSkipReason }, async (t) => {
  const WebhookSubscriptionModel = (await import("../models/WebhookSubscriptionModel.js")).default;
  const WebhookDeliveryModel = (await import("../models/WebhookDeliveryModel.js")).default;
  const WebhookService = (await import("../services/WebhookService.js")).default;

  const tenantId = `test-webhook-abandon-${Date.now()}`;
  t.after(async () => {
    await WebhookSubscriptionModel.deleteMany({ tenantId });
    await WebhookDeliveryModel.deleteMany({ tenantId });
  });

  const subscription = await WebhookSubscriptionModel.create({
    tenantId, url: "http://127.0.0.1:1/unreachable", secret: "test-secret", subscribedEvents: ["*"], status: "Suspended"
  });
  const delivery = await WebhookDeliveryModel.create({
    tenantId, webhookSubscriptionId: subscription._id, eventId: "evt-abandon", eventType: "WebhookAbandonTestEvent",
    payload: { tenantId }, signature: "sig", signedTimestamp: Math.floor(Date.now() / 1000),
    status: "Retrying", nextRetryAt: new Date(Date.now() - 1000), longRetryAttempt: 1
  });

  const processed = await WebhookService.processDueRetries();
  assert.ok(processed >= 1);

  const reloaded = await WebhookDeliveryModel.findById(delivery._id).lean();
  assert.equal(reloaded.status, "Abandoned");
  assert.equal(reloaded.nextRetryAt, null);
});

test("processDueRetries: a scheduled retry that succeeds genuinely recovers Retrying -> Delivered", { skip: !dbAvailable && dbSkipReason }, async (t) => {
  const WebhookSubscriptionModel = (await import("../models/WebhookSubscriptionModel.js")).default;
  const WebhookDeliveryModel = (await import("../models/WebhookDeliveryModel.js")).default;
  const WebhookService = (await import("../services/WebhookService.js")).default;

  process.env.WEBHOOK_RETRY_MAX_ATTEMPTS = "1";
  process.env.WEBHOOK_RETRY_BASE_DELAY_MS = "10";

  const { server, url } = await startOkServer();
  const tenantId = `test-webhook-recover-${Date.now()}`;

  t.after(async () => {
    delete process.env.WEBHOOK_RETRY_MAX_ATTEMPTS;
    delete process.env.WEBHOOK_RETRY_BASE_DELAY_MS;
    await WebhookSubscriptionModel.deleteMany({ tenantId });
    await WebhookDeliveryModel.deleteMany({ tenantId });
    await new Promise((resolve) => server.close(resolve));
  });

  const subscription = await WebhookSubscriptionModel.create({
    tenantId, url, secret: "test-secret", subscribedEvents: ["*"], status: "Active", consecutiveFailureCount: 3
  });
  const delivery = await WebhookDeliveryModel.create({
    tenantId, webhookSubscriptionId: subscription._id, eventId: "evt-recover", eventType: "WebhookRecoverTestEvent",
    payload: { tenantId, occurredAt: new Date().toISOString() }, signature: "sig", signedTimestamp: Math.floor(Date.now() / 1000),
    status: "Retrying", nextRetryAt: new Date(Date.now() - 1000), longRetryAttempt: 2
  });

  await WebhookService.processDueRetries();

  const reloaded = await WebhookDeliveryModel.findById(delivery._id).lean();
  assert.equal(reloaded.status, "Delivered");
  assert.ok(reloaded.deliveredAt);
  assert.equal(reloaded.nextRetryAt, null);

  const reloadedSubscription = await WebhookSubscriptionModel.findById(subscription._id).lean();
  assert.equal(reloadedSubscription.consecutiveFailureCount, 0, "a genuine recovery resets the circuit breaker's own failure count");
});

test("getMonitoringSummary: real aggregation over actual subscriptions/deliveries — registered count, success rate, DLQ items", { skip: !dbAvailable && dbSkipReason }, async (t) => {
  const WebhookSubscriptionModel = (await import("../models/WebhookSubscriptionModel.js")).default;
  const WebhookDeliveryModel = (await import("../models/WebhookDeliveryModel.js")).default;
  const WebhookService = (await import("../services/WebhookService.js")).default;

  const tenantId = `test-webhook-monitor-${Date.now()}`;
  t.after(async () => {
    await WebhookSubscriptionModel.deleteMany({ tenantId });
    await WebhookDeliveryModel.deleteMany({ tenantId });
  });

  const sub1 = await WebhookSubscriptionModel.create({ tenantId, url: "http://127.0.0.1:1/a", secret: "s1", subscribedEvents: ["*"], status: "Active" });
  await WebhookSubscriptionModel.create({ tenantId, url: "http://127.0.0.1:1/b", secret: "s2", subscribedEvents: ["*"], status: "Active" });

  const baseDelivery = { tenantId, webhookSubscriptionId: sub1._id, eventId: "evt", payload: {}, signature: "sig", signedTimestamp: 1 };
  await WebhookDeliveryModel.create({ ...baseDelivery, eventType: "A", status: "Delivered", deliveredAt: new Date(), attempts: [{ attemptNumber: 1, succeeded: true }] });
  await WebhookDeliveryModel.create({ ...baseDelivery, eventType: "B", status: "Delivered", deliveredAt: new Date(), attempts: [{ attemptNumber: 1, succeeded: false }, { attemptNumber: 2, succeeded: true }] });
  await WebhookDeliveryModel.create({ ...baseDelivery, eventType: "C", status: "DeadLetterQueue", attempts: [{ attemptNumber: 1, succeeded: false }] });

  const summary = await WebhookService.getMonitoringSummary(tenantId, {});
  assert.equal(summary.registeredWebhooks, 2);
  assert.equal(summary.totalDeliveries, 3);
  assert.equal(summary.deliverySuccessRatePercent, Math.round((2 / 3) * 10000) / 100);
  assert.equal(summary.deliveriesWithRetries, 1, "only the delivery with more than one attempt counts as retried");
  assert.equal(summary.dlqItems, 1);
  assert.equal(summary.replayQueueItems, 1);
});

after(async () => {
  if (dbAvailable) await mongoose.disconnect();
});
