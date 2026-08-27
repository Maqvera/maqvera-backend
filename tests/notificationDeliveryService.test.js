import test, { after } from "node:test";
import assert from "node:assert/strict";
import dotenv from "dotenv";
import mongoose from "mongoose";
import { publishEvent } from "../utils/eventBus.js";
import { resolveChannel, isEmailish, buildMessage } from "../services/NotificationDeliveryService.js";

dotenv.config();

// Gap 1.1 "Notification delivery is a dead end" — NotificationDeliveryService
// is the first real, global subscriber for NotificationRequested/
// SecurityNotificationRequested/SupplierNotificationRequested. Same
// dbAvailable-gated, direct-service-call convention as
// tests/packagePricingController.test.js; the async delivery path is
// exercised with an injected stub adapter (never a live SMTP/SMS call),
// polling for the resulting NotificationLogModel row the same way
// tests/webhookDeliveryIntegration.test.js already waits on a
// publishEvent-driven async side effect.

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

const waitFor = async (predicate, { timeoutMs = 5000, intervalMs = 50 } = {}) => {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await predicate();
    if (last) return last;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return last;
};

// ---- Pure unit tests (no DB, no event bus) ----

test("resolveChannel uses a valid payload.channel, otherwise the configured default", () => {
  assert.equal(resolveChannel({ channel: "SMS" }), "SMS");
  assert.equal(resolveChannel({ channel: "NotARealChannel" }), "Email");
  assert.equal(resolveChannel({}), "Email");
});

test("isEmailish is a format check only, never a business-rule guess", () => {
  assert.equal(isEmailish("agent@maqvera.test"), true);
  assert.equal(isEmailish("not-an-email"), false);
  assert.equal(isEmailish(null), false);
  assert.equal(isEmailish(undefined), false);
  assert.equal(isEmailish(12345), false);
});

test("buildMessage labels the message from event/type and never leaks the resolved email into the printed body", () => {
  const { subject, body } = buildMessage("NotificationRequested", { event: "BookingCancelled", email: "leak@example.com", bookingId: "abc" });
  assert.equal(subject, "[BookingCancelled]");
  assert.ok(!body.includes("leak@example.com"), "the recipient address must not be echoed into the message body");
  assert.ok(body.includes("bookingId"));
});

test("buildMessage falls back to payload.type then sourceEvent when no event/type is present", () => {
  assert.equal(buildMessage("NotificationRequested", { type: "welcome_customer" }).subject, "[welcome_customer]");
  assert.equal(buildMessage("SupplierNotificationRequested", {}).subject, "[SupplierNotificationRequested]");
});

// ---- DB-gated integration tests (stubbed transport, real event bus + DB) ----

test("NotificationDeliveryService: direct email, tenant-admin routing, recipientId lookup, ReceivableCollectionEscalated exclusion, and unresolvable-supplier honesty", { skip: !dbAvailable && dbSkipReason }, async (t) => {
  const { default: NotificationDeliveryService } = await import("../services/NotificationDeliveryService.js");
  const NotificationLogModel = (await import("../models/NotificationLogModel.js")).default;
  const RoleModel = (await import("../models/Rolemodel.js")).default;
  const UserModel = (await import("../models/Usermodel.js")).default;

  const suffix = Date.now();
  const tenantId = `test-notif-delivery-${suffix}`;

  t.after(async () => {
    await Promise.all([
      NotificationLogModel.deleteMany({ tenantId }),
      RoleModel.deleteMany({ tenantId }),
      UserModel.deleteMany({ tenantId })
    ]);
  });

  const sendCalls = [];
  const stubAdapter = { send: async (params) => { sendCalls.push(params); return { status: "Sent", providerResponse: { stub: true }, failureReason: null }; } };
  const resolveAdapter = (channel) => (channel === "Email" ? stubAdapter : null);

  // initEventListeners is idempotent (matches every other *Service in this
  // codebase) — this is the only test file that calls it, so the injected
  // stub resolver is what every event below is delivered through.
  NotificationDeliveryService.initEventListeners({ resolveAdapter });

  // 1. Direct email — no DB lookup needed to resolve the recipient.
  publishEvent("NotificationRequested", { tenantId, event: "TestDirectEmail", email: "direct@example.com" });
  const directLog = await waitFor(() => NotificationLogModel.findOne({ tenantId, event: "TestDirectEmail" }).lean());
  assert.ok(directLog, "expected a NotificationLog row for the direct-email case");
  assert.equal(directLog.status, "Sent");
  assert.equal(directLog.recipient, "direct@example.com");
  assert.equal(directLog.recipientSource, "payload.email");
  assert.equal(sendCalls.some((c) => c.to === "direct@example.com"), true);

  // 2. ReceivableCollectionEscalated is CustomerCollectionService's own —
  // this listener must never also deliver it (would double-send).
  publishEvent("NotificationRequested", { tenantId, event: "ReceivableCollectionEscalated", customerId: "cust1", channel: "Email" });
  await new Promise((resolve) => setTimeout(resolve, 300));
  const escalatedLog = await NotificationLogModel.findOne({ tenantId, event: "ReceivableCollectionEscalated" }).lean();
  assert.equal(escalatedLog, null, "NotificationDeliveryService must never handle ReceivableCollectionEscalated — that stays CustomerCollectionService's own");

  // 3. AIAlertTriggered at high priority with no direct recipient — routes to the tenant's own permission-holding admins.
  const adminRole = await RoleModel.create({ tenantId, name: "TestAdminRole", permissions: ["admin"], status: "active" });
  const adminUser = await UserModel.create({ username: `admin-${suffix}`, email: `admin-${suffix}@example.com`, password: "hashed", tenantId, role: adminRole.name, status: "active" });
  publishEvent("NotificationRequested", { tenantId, event: "AIAlertTriggered", priority: "high", alertId: "alert1", alertType: "cost_spike", message: "test" });
  const adminLog = await waitFor(() => NotificationLogModel.findOne({ tenantId, event: "AIAlertTriggered", recipientSource: "tenantAdmin" }).lean());
  assert.ok(adminLog, "expected a tenantAdmin-routed NotificationLog row for a high-priority AIAlertTriggered");
  assert.equal(adminLog.recipient, adminUser.email);
  assert.equal(adminLog.status, "Sent");

  // 4. recipientId resolves through a real User lookup (the AI-approval/incident shape).
  const targetUser = await UserModel.create({ username: `target-${suffix}`, email: `target-${suffix}@example.com`, password: "hashed", tenantId, role: "User", status: "active" });
  publishEvent("NotificationRequested", { tenantId, event: "TestRecipientIdLookup", recipientId: targetUser._id.toString() });
  const recipientIdLog = await waitFor(() => NotificationLogModel.findOne({ tenantId, event: "TestRecipientIdLookup" }).lean());
  assert.ok(recipientIdLog, "expected a NotificationLog row for the recipientId-lookup case");
  assert.equal(recipientIdLog.recipient, targetUser.email);
  assert.equal(recipientIdLog.recipientSource, "recipientId");

  // 5. SupplierNotificationRequested — its one real publisher carries no
  // contact/webhook at all, so this must be an honest NotConfigured, never
  // a fabricated delivery, and the stub adapter must never be invoked.
  const preCallCount = sendCalls.length;
  publishEvent("SupplierNotificationRequested", { tenantId, bookingId: "bk1", action: "release_resources" });
  const supplierLog = await waitFor(() => NotificationLogModel.findOne({ tenantId, sourceEvent: "SupplierNotificationRequested" }).lean());
  assert.ok(supplierLog, "expected a NotificationLog row for the supplier-notification case");
  assert.equal(supplierLog.status, "NotConfigured");
  assert.equal(supplierLog.recipient, null);
  assert.equal(sendCalls.length, preCallCount, "the stub transport must never be called when no recipient contact was resolved");

  // 6. SecurityNotificationRequested — real Auth.js shape ({ userId, email, type }).
  publishEvent("SecurityNotificationRequested", { userId: "u1", email: "security@example.com", type: "password_reset" });
  const securityLog = await waitFor(() => NotificationLogModel.findOne({ sourceEvent: "SecurityNotificationRequested", recipient: "security@example.com" }).lean());
  assert.ok(securityLog, "expected a NotificationLog row for the security-notification case");
  assert.equal(securityLog.status, "Sent");
  assert.equal(securityLog.event, "password_reset");
  t.after(async () => { await NotificationLogModel.deleteMany({ recipient: "security@example.com" }); });
});

after(async () => {
  if (dbAvailable) await mongoose.disconnect();
});
