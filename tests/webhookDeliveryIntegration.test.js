import test, { after } from "node:test";
import assert from "node:assert/strict";
import dotenv from "dotenv";
import mongoose from "mongoose";
import http from "node:http";

dotenv.config();

// Finance Module Part 18 Part 5 (Enterprise Production Readiness) — proves
// the real webhook fan-out end to end: publishing a domain event through
// the actual utils/eventBus.js wildcard listener genuinely reaches a real
// local HTTP endpoint, correctly HMAC-signed, and is recorded immutably.
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

test("WebhookService: a published domain event is really delivered, HMAC-signed, to a subscribed endpoint", { skip: !dbAvailable && dbSkipReason }, async (t) => {
  const WebhookSubscriptionModel = (await import("../models/WebhookSubscriptionModel.js")).default;
  const WebhookDeliveryModel = (await import("../models/WebhookDeliveryModel.js")).default;
  const WebhookService = (await import("../services/WebhookService.js")).default;
  const { computeWebhookSignature } = await import("../services/WebhookService.js");
  const { publishEvent } = await import("../utils/eventBus.js");

  WebhookService.initEventListeners();

  const receivedRequests = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      receivedRequests.push({ headers: req.headers, body });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ received: true }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const url = `http://127.0.0.1:${port}/webhook`;

  const suffix = `webhook-${Date.now()}`;
  const tenantId = `test-${suffix}`;

  t.after(async () => {
    await WebhookSubscriptionModel.deleteMany({ tenantId });
    await WebhookDeliveryModel.deleteMany({ tenantId });
    await new Promise((resolve) => server.close(resolve));
  });

  const subscription = await WebhookService.createSubscription({
    url, subscribedEvents: ["TestEventForWebhookIntegration"]
  }, tenantId, "tester");
  assert.ok(subscription.secret, "expected the plaintext secret on creation");

  publishEvent("TestEventForWebhookIntegration", { tenantId, sampleField: 42 });

  // publishEvent dispatches via queueMicrotask; the webhook delivery
  // itself is a real HTTP round trip, so poll briefly for it to land
  // rather than assuming a fixed delay.
  const deadline = Date.now() + 5000;
  while (receivedRequests.length === 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  assert.equal(receivedRequests.length, 1, "expected exactly one real HTTP delivery to the subscriber endpoint");
  const received = receivedRequests[0];
  assert.ok(received.headers["x-webhook-signature"], "expected a real signature header");
  assert.equal(received.headers["x-webhook-event"], "TestEventForWebhookIntegration");

  const expectedSignature = computeWebhookSignature(subscription.secret, Number(received.headers["x-webhook-timestamp"]), received.body);
  assert.equal(received.headers["x-webhook-signature"], expectedSignature, "signature must verify against the subscription's own secret");

  const deliveries = await WebhookDeliveryModel.find({ tenantId }).lean();
  assert.equal(deliveries.length, 1);
  assert.equal(deliveries[0].status, "Delivered");
  assert.equal(deliveries[0].attempts.length, 1);
  assert.equal(deliveries[0].attempts[0].succeeded, true);

  const reloadedSubscription = await WebhookSubscriptionModel.findById(subscription._id).lean();
  assert.equal(reloadedSubscription.consecutiveFailureCount, 0);
  assert.ok(reloadedSubscription.lastDeliveryAt);
});

after(async () => {
  if (dbAvailable) await mongoose.disconnect();
});
