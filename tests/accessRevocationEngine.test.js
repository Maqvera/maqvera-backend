import test, { after } from "node:test";
import assert from "node:assert/strict";
import dotenv from "dotenv";
import mongoose from "mongoose";

dotenv.config();

// Enterprise Subscription Automation Layer — Automation #5 (Enterprise
// Automatic Access Revocation Engine). Proves, against a real database:
// suspendTenant genuinely pauses the tenant's own real WebhookSubscriptionModel
// rows (so the EXISTING delivery dispatch naturally stops, zero code
// changes needed there) and publishes the real granular versioned events;
// reactivateTenant restores ONLY the webhooks IT paused, never one the
// tenant had already suspended for its own reason; the real
// suspensionExempt gate blocks an AUTOMATIC suspension but never a manual
// one; enforceGracePeriodSuspensions correctly skips counting an exempt
// tenant as suspended; and the real blockedRequestCount counter increments
// atomically.
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

test("suspendTenant: pauses the tenant's own real webhook subscriptions and publishes the granular versioned events + spec-shaped ACCESS_REVOKED audit", { skip: !dbAvailable && dbSkipReason }, async (t) => {
  const TenantModel = (await import("../models/Tenantmodel.js")).default;
  const SessionModel = (await import("../models/Sessionmodel.js")).default;
  const PlatformPlanModel = (await import("../models/PlatformPlanModel.js")).default;
  const TenantSubscriptionModel = (await import("../models/TenantSubscriptionModel.js")).default;
  const WebhookSubscriptionModel = (await import("../models/WebhookSubscriptionModel.js")).default;
  const AuditLogModel = (await import("../models/AuditLogmodel.js")).default;
  const TenantSubscriptionService = (await import("../services/TenantSubscriptionService.js")).default;
  const { subscribeEvent } = await import("../utils/eventBus.js");

  const suffix = `revoke-${Date.now()}`;
  const tenantId = `test-${suffix}`;
  const receivedEvents = [];
  const eventNames = ["MerchantSuspendedStarted", "MerchantSuspended.v1", "AccessRevoked.v1", "ApiAccessRevoked.v1", "UserSessionsRevoked.v1", "WebhooksDisabled.v1"];
  const unsubs = eventNames.map((name) => subscribeEvent(name, (payload) => receivedEvents.push({ name, payload })));

  t.after(async () => {
    await TenantModel.deleteMany({ tenantKey: tenantId });
    await SessionModel.deleteMany({ tenantId });
    await PlatformPlanModel.deleteMany({ planCode: `TESTPLAN-${suffix}` });
    await TenantSubscriptionModel.deleteMany({ tenantId });
    await WebhookSubscriptionModel.deleteMany({ tenantId });
    await AuditLogModel.deleteMany({ tenantId, action: { $in: ["ACCESS_REVOKED", "platform.tenant.suspend"] } });
    unsubs.forEach((unsub) => { if (typeof unsub === "function") unsub(); });
  });

  await TenantModel.create({ tenantKey: tenantId, name: `Test Tenant ${suffix}`, status: "active" });
  const plan = await PlatformPlanModel.create({ planCode: `TESTPLAN-${suffix}`, name: "Starter", tier: "Starter", pricing: { currency: "USD", monthly: 29 } });
  await TenantSubscriptionModel.create({
    tenantId, planId: plan._id, planTier: plan.tier, planCode: plan.planCode, billingCycle: "Monthly", amount: 29, currency: "USD",
    status: "GracePeriod", currentPeriodStart: new Date(Date.now() - 40 * 86400000), currentPeriodEnd: new Date(Date.now() - 10 * 86400000),
    graceStartedAt: new Date(Date.now() - 3 * 86400000), gracePeriodEndsAt: new Date(Date.now() - 1000)
  });
  await SessionModel.create({ userId: new mongoose.Types.ObjectId(), email: "tester@example.com", tenantId, refreshTokenHash: "fake-hash", status: "active", expiresAt: new Date(Date.now() + 86400000) });

  const activeWebhook = await WebhookSubscriptionModel.create({ tenantId, url: "https://example.com/hook-active", subscribedEvents: ["*"], status: "Active", secret: "test-secret-1" });
  const alreadySuspendedWebhook = await WebhookSubscriptionModel.create({ tenantId, url: "https://example.com/hook-failed", subscribedEvents: ["*"], status: "Suspended", suspendedReason: "Auto-suspended after 10 consecutive delivery failures.", secret: "test-secret-2" });

  const result = await TenantSubscriptionService.suspendTenant(tenantId, "SUBSCRIPTION_EXPIRED", "system", { automatic: true });
  assert.equal(result.status, "suspended");
  assert.equal(result.webhooksPaused, 1, "only the one real Active webhook subscription should be paused");

  const reloadedActiveWebhook = await WebhookSubscriptionModel.findOne({ _id: activeWebhook._id }).lean();
  assert.equal(reloadedActiveWebhook.status, "Suspended");
  assert.equal(reloadedActiveWebhook.suspendedReason, "Tenant subscription suspended.");

  const reloadedAlreadySuspended = await WebhookSubscriptionModel.findOne({ _id: alreadySuspendedWebhook._id }).lean();
  assert.equal(reloadedAlreadySuspended.suspendedReason, "Auto-suspended after 10 consecutive delivery failures.", "a webhook already suspended for its own real reason must be left untouched");

  const auditEntry = await AuditLogModel.findOne({ action: "ACCESS_REVOKED", tenantId }).lean();
  assert.ok(auditEntry, "every revocation MUST be fully audited");
  assert.equal(auditEntry.details.merchantId, tenantId);
  assert.equal(auditEntry.details.automatic, true);
  assert.ok(auditEntry.details.graceExpiredAt, "the real gracePeriodEndsAt at suspend time must be captured");

  await new Promise((resolve) => setTimeout(resolve, 40));
  for (const name of ["MerchantSuspended.v1", "AccessRevoked.v1", "ApiAccessRevoked.v1", "UserSessionsRevoked.v1", "WebhooksDisabled.v1"]) {
    assert.ok(receivedEvents.some((e) => e.name === name), `${name} must publish on a real suspension`);
  }
});

test("reactivateTenant: restores only the webhook subscriptions IT paused for tenant-suspension, never one already Suspended for its own reason", { skip: !dbAvailable && dbSkipReason }, async (t) => {
  const TenantModel = (await import("../models/Tenantmodel.js")).default;
  const PlatformPlanModel = (await import("../models/PlatformPlanModel.js")).default;
  const TenantSubscriptionModel = (await import("../models/TenantSubscriptionModel.js")).default;
  const WebhookSubscriptionModel = (await import("../models/WebhookSubscriptionModel.js")).default;
  const TenantSubscriptionService = (await import("../services/TenantSubscriptionService.js")).default;

  const suffix = `reactivate-${Date.now()}`;
  const tenantId = `test-${suffix}`;

  t.after(async () => {
    await TenantModel.deleteMany({ tenantKey: tenantId });
    await PlatformPlanModel.deleteMany({ planCode: `TESTPLAN-${suffix}` });
    await TenantSubscriptionModel.deleteMany({ tenantId });
    await WebhookSubscriptionModel.deleteMany({ tenantId });
  });

  await TenantModel.create({ tenantKey: tenantId, name: `Test Tenant ${suffix}`, status: "active" });
  const plan = await PlatformPlanModel.create({ planCode: `TESTPLAN-${suffix}`, name: "Starter", tier: "Starter", pricing: { currency: "USD", monthly: 29 } });
  await TenantSubscriptionModel.create({
    tenantId, planId: plan._id, planTier: plan.tier, planCode: plan.planCode, billingCycle: "Monthly", amount: 29, currency: "USD",
    status: "Active", currentPeriodStart: new Date(), currentPeriodEnd: new Date(Date.now() + 30 * 86400000)
  });

  await TenantSubscriptionService.suspendTenant(tenantId, "Test suspension.", "tester");
  const ownReasonWebhook = await WebhookSubscriptionModel.create({ tenantId, url: "https://example.com/own-reason", subscribedEvents: ["*"], status: "Suspended", suspendedReason: "Auto-suspended after 10 consecutive delivery failures.", secret: "test-secret-3" });
  const platformPausedWebhook = await WebhookSubscriptionModel.create({ tenantId, url: "https://example.com/platform-paused", subscribedEvents: ["*"], status: "Suspended", suspendedReason: "Tenant subscription suspended.", secret: "test-secret-4" });

  const result = await TenantSubscriptionService.reactivateTenant(tenantId, "tester");
  assert.equal(result.webhooksRestored, 1);

  const reloadedOwnReason = await WebhookSubscriptionModel.findOne({ _id: ownReasonWebhook._id }).lean();
  assert.equal(reloadedOwnReason.status, "Suspended", "a webhook suspended for its own reason must stay suspended after tenant reactivation");

  const reloadedPlatformPaused = await WebhookSubscriptionModel.findOne({ _id: platformPausedWebhook._id }).lean();
  assert.equal(reloadedPlatformPaused.status, "Active");
  assert.equal(reloadedPlatformPaused.suspendedReason, null);
});

test("suspensionExempt: blocks an AUTOMATIC suspension (flags SuspensionExceptionFlagged.v1 instead) but never a manual one", { skip: !dbAvailable && dbSkipReason }, async (t) => {
  const TenantModel = (await import("../models/Tenantmodel.js")).default;
  const PlatformPlanModel = (await import("../models/PlatformPlanModel.js")).default;
  const TenantSubscriptionModel = (await import("../models/TenantSubscriptionModel.js")).default;
  const AuditLogModel = (await import("../models/AuditLogmodel.js")).default;
  const TenantSubscriptionService = (await import("../services/TenantSubscriptionService.js")).default;
  const { subscribeEvent } = await import("../utils/eventBus.js");

  const suffix = `exempt-${Date.now()}`;
  const tenantId = `test-${suffix}`;
  const receivedEvents = [];
  const unsub = subscribeEvent("SuspensionExceptionFlagged.v1", (payload) => receivedEvents.push(payload));

  t.after(async () => {
    await TenantModel.deleteMany({ tenantKey: tenantId });
    await PlatformPlanModel.deleteMany({ planCode: `TESTPLAN-${suffix}` });
    await TenantSubscriptionModel.deleteMany({ tenantId });
    await AuditLogModel.deleteMany({ tenantId, action: "SUSPENSION_EXCEPTION_FLAGGED" });
    if (typeof unsub === "function") unsub();
  });

  await TenantModel.create({ tenantKey: tenantId, name: `Test Tenant ${suffix}`, status: "active" });
  const plan = await PlatformPlanModel.create({ planCode: `TESTPLAN-${suffix}`, name: "Enterprise", tier: "Enterprise", pricing: { currency: "USD", monthly: 999 } });
  await TenantSubscriptionModel.create({
    tenantId, planId: plan._id, planTier: plan.tier, planCode: plan.planCode, billingCycle: "Monthly", amount: 999, currency: "USD",
    status: "GracePeriod", currentPeriodStart: new Date(Date.now() - 40 * 86400000), currentPeriodEnd: new Date(Date.now() - 10 * 86400000),
    gracePeriodEndsAt: new Date(Date.now() - 1000), suspensionExempt: true, suspensionExemptReason: "Enterprise contract — manual review required."
  });

  const automaticResult = await TenantSubscriptionService.suspendTenant(tenantId, "SUBSCRIPTION_EXPIRED", "system", { automatic: true });
  assert.equal(automaticResult.status, "exempt");

  const reloadedAfterAutomatic = await TenantModel.findOne({ tenantKey: tenantId }).lean();
  assert.equal(reloadedAfterAutomatic.status, "active", "an exempt tenant must never be automatically suspended");

  const auditEntry = await AuditLogModel.findOne({ tenantId, action: "SUSPENSION_EXCEPTION_FLAGGED" }).lean();
  assert.ok(auditEntry, "the exception itself must still be audited for manual review");

  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(receivedEvents.length, 1);

  // A human explicitly suspending (automatic: false, the real default) still works even on an exempt tenant.
  const manualResult = await TenantSubscriptionService.suspendTenant(tenantId, "Manual override by finance team.", "finance-admin");
  assert.equal(manualResult.status, "suspended");
  const reloadedAfterManual = await TenantModel.findOne({ tenantKey: tenantId }).lean();
  assert.equal(reloadedAfterManual.status, "suspended");
});

test("enforceGracePeriodSuspensions: an exempt tenant whose grace expires is flagged, not counted as a real suspension", { skip: !dbAvailable && dbSkipReason }, async (t) => {
  const TenantModel = (await import("../models/Tenantmodel.js")).default;
  const PlatformPlanModel = (await import("../models/PlatformPlanModel.js")).default;
  const TenantSubscriptionModel = (await import("../models/TenantSubscriptionModel.js")).default;
  const TenantSubscriptionService = (await import("../services/TenantSubscriptionService.js")).default;

  const suffix = `exemptsweep-${Date.now()}`;
  const tenantId = `test-${suffix}`;

  t.after(async () => {
    await TenantModel.deleteMany({ tenantKey: tenantId });
    await PlatformPlanModel.deleteMany({ planCode: `TESTPLAN-${suffix}` });
    await TenantSubscriptionModel.deleteMany({ tenantId });
  });

  await TenantModel.create({ tenantKey: tenantId, name: `Test Tenant ${suffix}`, status: "active" });
  const plan = await PlatformPlanModel.create({ planCode: `TESTPLAN-${suffix}`, name: "Enterprise", tier: "Enterprise", pricing: { currency: "USD", monthly: 999 } });
  await TenantSubscriptionModel.create({
    tenantId, planId: plan._id, planTier: plan.tier, planCode: plan.planCode, billingCycle: "Monthly", amount: 999, currency: "USD",
    status: "GracePeriod", currentPeriodStart: new Date(Date.now() - 40 * 86400000), currentPeriodEnd: new Date(Date.now() - 10 * 86400000),
    gracePeriodEndsAt: new Date(Date.now() - 1000), suspensionExempt: true, suspensionExemptReason: "Enterprise contract."
  });

  const result = await TenantSubscriptionService.enforceGracePeriodSuspensions();
  assert.equal(result.processed, 1);
  assert.equal(result.suspended, 0, "an exempt tenant must not be counted as a real suspension");

  const reloadedTenant = await TenantModel.findOne({ tenantKey: tenantId }).lean();
  assert.equal(reloadedTenant.status, "active");
});

test("recordBlockedRequest: real atomic counter increment", { skip: !dbAvailable && dbSkipReason }, async (t) => {
  const TenantModel = (await import("../models/Tenantmodel.js")).default;
  const PlatformPlanModel = (await import("../models/PlatformPlanModel.js")).default;
  const TenantSubscriptionModel = (await import("../models/TenantSubscriptionModel.js")).default;
  const TenantSubscriptionService = (await import("../services/TenantSubscriptionService.js")).default;

  const suffix = `blockcount-${Date.now()}`;
  const tenantId = `test-${suffix}`;

  t.after(async () => {
    await TenantModel.deleteMany({ tenantKey: tenantId });
    await PlatformPlanModel.deleteMany({ planCode: `TESTPLAN-${suffix}` });
    await TenantSubscriptionModel.deleteMany({ tenantId });
  });

  await TenantModel.create({ tenantKey: tenantId, name: `Test Tenant ${suffix}`, status: "active" });
  const plan = await PlatformPlanModel.create({ planCode: `TESTPLAN-${suffix}`, name: "Starter", tier: "Starter", pricing: { currency: "USD", monthly: 29 } });
  await TenantSubscriptionModel.create({
    tenantId, planId: plan._id, planTier: plan.tier, planCode: plan.planCode, billingCycle: "Monthly", amount: 29, currency: "USD",
    status: "Active", currentPeriodStart: new Date(), currentPeriodEnd: new Date(Date.now() + 30 * 86400000)
  });

  TenantSubscriptionService.recordBlockedRequest(tenantId);
  TenantSubscriptionService.recordBlockedRequest(tenantId);
  await new Promise((resolve) => setTimeout(resolve, 100));

  const reloaded = await TenantSubscriptionModel.findOne({ tenantId }).lean();
  assert.equal(reloaded.blockedRequestCount, 2);
});

after(async () => {
  if (dbAvailable) await mongoose.disconnect();
});
