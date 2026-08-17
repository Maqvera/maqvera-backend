import test, { after } from "node:test";
import assert from "node:assert/strict";
import dotenv from "dotenv";
import mongoose from "mongoose";

dotenv.config();

// Enterprise Subscription Automation Layer — Automation #6 (Enterprise
// Subscription Enforcement Middleware). Proves, against a real database:
// getEnforcementBlock now genuinely blocks Cancelled/Archived subscriptions
// (not just Suspended/Expired); recordBlockedRequest writes a real,
// spec-shaped SUBSCRIPTION_BLOCK audit entry and publishes
// SubscriptionCheckFailed.v1; a real state change (suspendTenant)
// publishes SubscriptionCacheInvalidated.v1; checkFeatureAccess denial
// publishes the new versioned FeatureAccessDenied.v1 alongside the
// existing plain event; and utils/rateLimiter.js#resolveLimit now
// genuinely consults the tenant's own real PlatformPlanModel-configured
// limit when no explicit admin rule exists.
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

test("getEnforcementBlock: genuinely blocks Cancelled and Archived subscriptions, not just Suspended/Expired", { skip: !dbAvailable && dbSkipReason }, async (t) => {
  const TenantModel = (await import("../models/Tenantmodel.js")).default;
  const PlatformPlanModel = (await import("../models/PlatformPlanModel.js")).default;
  const TenantSubscriptionModel = (await import("../models/TenantSubscriptionModel.js")).default;
  const TenantSubscriptionService = (await import("../services/TenantSubscriptionService.js")).default;

  const suffix = `blockstates-${Date.now()}`;
  const cancelledTenantId = `test-cancelled-${suffix}`;
  const archivedTenantId = `test-archived-${suffix}`;

  t.after(async () => {
    await TenantModel.deleteMany({ tenantKey: { $in: [cancelledTenantId, archivedTenantId] } });
    await PlatformPlanModel.deleteMany({ planCode: `TESTPLAN-${suffix}` });
    await TenantSubscriptionModel.deleteMany({ tenantId: { $in: [cancelledTenantId, archivedTenantId] } });
  });

  const plan = await PlatformPlanModel.create({ planCode: `TESTPLAN-${suffix}`, name: "Starter", tier: "Starter", pricing: { currency: "USD", monthly: 29 } });

  await TenantModel.create({ tenantKey: cancelledTenantId, name: "Cancelled Tenant", status: "active" });
  await TenantSubscriptionModel.create({ tenantId: cancelledTenantId, planId: plan._id, planTier: plan.tier, planCode: plan.planCode, billingCycle: "Monthly", amount: 29, currency: "USD", status: "Cancelled", currentPeriodStart: new Date(), currentPeriodEnd: new Date() });

  await TenantModel.create({ tenantKey: archivedTenantId, name: "Archived Tenant", status: "active" });
  await TenantSubscriptionModel.create({ tenantId: archivedTenantId, planId: plan._id, planTier: plan.tier, planCode: plan.planCode, billingCycle: "Monthly", amount: 29, currency: "USD", status: "Archived", currentPeriodStart: new Date(), currentPeriodEnd: new Date() });

  const cancelledBlock = await TenantSubscriptionService.getEnforcementBlock(cancelledTenantId);
  assert.equal(cancelledBlock.code, "SUBSCRIPTION_CANCELLED");
  assert.equal(cancelledBlock.httpStatus, 402);

  const archivedBlock = await TenantSubscriptionService.getEnforcementBlock(archivedTenantId);
  assert.equal(archivedBlock.code, "SUBSCRIPTION_ARCHIVED");
  assert.equal(archivedBlock.httpStatus, 403);
});

test("recordBlockedRequest: writes a real spec-shaped SUBSCRIPTION_BLOCK audit entry and publishes SubscriptionCheckFailed.v1", { skip: !dbAvailable && dbSkipReason }, async (t) => {
  const TenantModel = (await import("../models/Tenantmodel.js")).default;
  const PlatformPlanModel = (await import("../models/PlatformPlanModel.js")).default;
  const TenantSubscriptionModel = (await import("../models/TenantSubscriptionModel.js")).default;
  const AuditLogModel = (await import("../models/AuditLogmodel.js")).default;
  const TenantSubscriptionService = (await import("../services/TenantSubscriptionService.js")).default;
  const { subscribeEvent } = await import("../utils/eventBus.js");

  const suffix = `recordblock-${Date.now()}`;
  const tenantId = `test-${suffix}`;
  const receivedEvents = [];
  const unsub = subscribeEvent("SubscriptionCheckFailed.v1", (payload) => receivedEvents.push(payload));

  t.after(async () => {
    await TenantModel.deleteMany({ tenantKey: tenantId });
    await PlatformPlanModel.deleteMany({ planCode: `TESTPLAN-${suffix}` });
    await TenantSubscriptionModel.deleteMany({ tenantId });
    await AuditLogModel.deleteMany({ tenantId, action: "SUBSCRIPTION_BLOCK" });
    if (typeof unsub === "function") unsub();
  });

  await TenantModel.create({ tenantKey: tenantId, name: `Test Tenant ${suffix}`, status: "active" });
  const plan = await PlatformPlanModel.create({ planCode: `TESTPLAN-${suffix}`, name: "Starter", tier: "Starter", pricing: { currency: "USD", monthly: 29 } });
  await TenantSubscriptionModel.create({ tenantId, planId: plan._id, planTier: plan.tier, planCode: plan.planCode, billingCycle: "Monthly", amount: 29, currency: "USD", status: "Suspended", currentPeriodStart: new Date(), currentPeriodEnd: new Date() });

  TenantSubscriptionService.recordBlockedRequest(tenantId, { endpoint: "POST /api/v1/invoices", code: "SUBSCRIPTION_SUSPENDED" });
  await new Promise((resolve) => setTimeout(resolve, 80));

  const reloaded = await TenantSubscriptionModel.findOne({ tenantId }).lean();
  assert.equal(reloaded.blockedRequestCount, 1);

  const auditEntry = await AuditLogModel.findOne({ tenantId, action: "SUBSCRIPTION_BLOCK" }).lean();
  assert.ok(auditEntry, "every blocked request MUST be audited");
  assert.equal(auditEntry.details.merchantId, tenantId);
  assert.equal(auditEntry.details.endpoint, "POST /api/v1/invoices");
  assert.equal(auditEntry.details.reason, "SUBSCRIPTION_SUSPENDED");

  assert.equal(receivedEvents.length, 1);
  assert.equal(receivedEvents[0].data.endpoint, "POST /api/v1/invoices");
});

test("suspendTenant: a real state change publishes SubscriptionCacheInvalidated.v1", { skip: !dbAvailable && dbSkipReason }, async (t) => {
  const TenantModel = (await import("../models/Tenantmodel.js")).default;
  const PlatformPlanModel = (await import("../models/PlatformPlanModel.js")).default;
  const TenantSubscriptionModel = (await import("../models/TenantSubscriptionModel.js")).default;
  const TenantSubscriptionService = (await import("../services/TenantSubscriptionService.js")).default;
  const { subscribeEvent } = await import("../utils/eventBus.js");

  const suffix = `cacheinvalidate-${Date.now()}`;
  const tenantId = `test-${suffix}`;
  const receivedEvents = [];
  const unsub = subscribeEvent("SubscriptionCacheInvalidated.v1", (payload) => receivedEvents.push(payload));

  t.after(async () => {
    await TenantModel.deleteMany({ tenantKey: tenantId });
    await PlatformPlanModel.deleteMany({ planCode: `TESTPLAN-${suffix}` });
    await TenantSubscriptionModel.deleteMany({ tenantId });
    if (typeof unsub === "function") unsub();
  });

  await TenantModel.create({ tenantKey: tenantId, name: `Test Tenant ${suffix}`, status: "active" });
  const plan = await PlatformPlanModel.create({ planCode: `TESTPLAN-${suffix}`, name: "Starter", tier: "Starter", pricing: { currency: "USD", monthly: 29 } });
  await TenantSubscriptionModel.create({ tenantId, planId: plan._id, planTier: plan.tier, planCode: plan.planCode, billingCycle: "Monthly", amount: 29, currency: "USD", status: "Active", currentPeriodStart: new Date(), currentPeriodEnd: new Date(Date.now() + 30 * 86400000) });

  await TenantSubscriptionService.suspendTenant(tenantId, "Test suspension.", "tester");

  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.ok(receivedEvents.length >= 1, "a real cache-invalidating state change must publish SubscriptionCacheInvalidated.v1");
});

test("checkFeatureAccess: a denial publishes the new versioned FeatureAccessDenied.v1 alongside the existing plain event", { skip: !dbAvailable && dbSkipReason }, async (t) => {
  const TenantModel = (await import("../models/Tenantmodel.js")).default;
  const PlatformPlanModel = (await import("../models/PlatformPlanModel.js")).default;
  const TenantSubscriptionModel = (await import("../models/TenantSubscriptionModel.js")).default;
  const TenantSubscriptionService = (await import("../services/TenantSubscriptionService.js")).default;
  const { subscribeEvent } = await import("../utils/eventBus.js");

  const suffix = `featuredenied-${Date.now()}`;
  const tenantId = `test-${suffix}`;
  const receivedVersioned = [];
  const unsub = subscribeEvent("FeatureAccessDenied.v1", (payload) => receivedVersioned.push(payload));

  t.after(async () => {
    await TenantModel.deleteMany({ tenantKey: tenantId });
    await PlatformPlanModel.deleteMany({ planCode: `TESTPLAN-${suffix}` });
    await TenantSubscriptionModel.deleteMany({ tenantId });
    if (typeof unsub === "function") unsub();
  });

  await TenantModel.create({ tenantKey: tenantId, name: `Test Tenant ${suffix}`, status: "active" });
  const plan = await PlatformPlanModel.create({ planCode: `TESTPLAN-${suffix}`, name: "Starter", tier: "Starter", pricing: { currency: "USD", monthly: 29 }, features: new Map([["payroll", false]]) });
  await TenantSubscriptionModel.create({ tenantId, planId: plan._id, planTier: plan.tier, planCode: plan.planCode, billingCycle: "Monthly", amount: 29, currency: "USD", status: "Active", currentPeriodStart: new Date(), currentPeriodEnd: new Date(Date.now() + 30 * 86400000) });

  const allowed = await TenantSubscriptionService.checkFeatureAccess(tenantId, "payroll");
  assert.equal(allowed, false);

  // publishVersionedEvent does a real DB round trip (EventRegistryModel)
  // BEFORE dispatching — fire-and-forget from checkFeatureAccess, so this
  // real async chain needs more headroom than the in-process eventBus
  // dispatch alone.
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(receivedVersioned.length, 1);
  assert.equal(receivedVersioned[0].data.featureKey, "payroll");
});

test("resolveLimit: genuinely consults the tenant's own real plan-based API limit when no explicit admin rule exists", { skip: !dbAvailable && dbSkipReason }, async (t) => {
  const TenantModel = (await import("../models/Tenantmodel.js")).default;
  const PlatformPlanModel = (await import("../models/PlatformPlanModel.js")).default;
  const TenantSubscriptionModel = (await import("../models/TenantSubscriptionModel.js")).default;
  const RateLimitRuleModel = (await import("../models/RateLimitRuleModel.js")).default;
  const { resolveLimit } = await import("../utils/rateLimiter.js");

  const suffix = `planlimit-${Date.now()}`;
  const tenantId = `test-${suffix}`;

  t.after(async () => {
    await TenantModel.deleteMany({ tenantKey: tenantId });
    await PlatformPlanModel.deleteMany({ planCode: `TESTPLAN-${suffix}` });
    await TenantSubscriptionModel.deleteMany({ tenantId });
    await RateLimitRuleModel.deleteMany({ tenantId });
  });

  await TenantModel.create({ tenantKey: tenantId, name: `Test Tenant ${suffix}`, status: "active" });
  const plan = await PlatformPlanModel.create({ planCode: `TESTPLAN-${suffix}`, name: "Professional", tier: "Professional", pricing: { currency: "USD", monthly: 99 }, limits: { maxApiCallsPerDay: 12345 } });
  await TenantSubscriptionModel.create({ tenantId, planId: plan._id, planTier: plan.tier, planCode: plan.planCode, billingCycle: "Monthly", amount: 99, currency: "USD", status: "Active", currentPeriodStart: new Date(), currentPeriodEnd: new Date(Date.now() + 30 * 86400000) });

  const resolved = await resolveLimit({ tenantId, scope: "Tenant" });
  assert.equal(resolved.limit, 12345, "the real plan-configured maxApiCallsPerDay must genuinely drive the resolved Tenant-scope limit");
  assert.equal(resolved.windowSeconds, 86400);
});

test("enforcementMetrics: real in-process average middleware time computation", async () => {
  const { recordEnforcementCheck, getEnforcementMetrics } = await import("../utils/enforcementMetrics.js");

  const before = getEnforcementMetrics();
  recordEnforcementCheck(10, false);
  recordEnforcementCheck(20, true);
  const after = getEnforcementMetrics();

  assert.equal(after.checksPerformed, before.checksPerformed + 2);
  assert.equal(after.blockedCount, before.blockedCount + 1);
  assert.ok(after.averageMiddlewareTimeMs !== null);
});

after(async () => {
  if (dbAvailable) await mongoose.disconnect();
});
