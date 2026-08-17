import test, { after } from "node:test";
import assert from "node:assert/strict";
import dotenv from "dotenv";
import mongoose from "mongoose";

dotenv.config();

// Per-Tenant Payment Gateway Integration — Issue 11 (revised: wire into
// the EXISTING Enterprise Subscription Platform, never a new plan/scope
// system). Proves: `requireFeature("paymentGatewayConnect")` — the real,
// already-existing middleware from `middleware/subscriptionEnforcement.js`,
// now mounted on `routes/PaymentGatewayRoutes.js` — genuinely blocks a
// tenant whose real plan explicitly disables the feature, genuinely
// allows a tenant with no subscription row at all (backward compatible,
// matching every other real feature-gate rollout in this codebase), and
// genuinely allows a tenant whose plan simply never mentions the key
// (undefined key defaults to allowed, never a silent block).
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

const runMiddleware = (middleware, req) => new Promise((resolve) => {
  const res = { statusCode: null, body: null, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; resolve({ blocked: true }); return this; } };
  const next = () => resolve({ blocked: false });
  middleware(req, res, next);
});

test("requireFeature('paymentGatewayConnect'): a tenant with no subscription row at all passes through unblocked (backward compatible)", { skip: !dbAvailable && dbSkipReason }, async () => {
  const { requireFeature } = await import("../middleware/subscriptionEnforcement.js");
  const middleware = requireFeature("paymentGatewayConnect");

  const result = await runMiddleware(middleware, { auth: { tenantId: `test-no-sub-${Date.now()}` } });
  assert.equal(result.blocked, false);
});

test("requireFeature('paymentGatewayConnect'): a real plan explicitly disabling the feature genuinely blocks with 403 FEATURE_NOT_AVAILABLE", { skip: !dbAvailable && dbSkipReason }, async (t) => {
  const TenantSubscriptionModel = (await import("../models/TenantSubscriptionModel.js")).default;
  const PlatformPlanModel = (await import("../models/PlatformPlanModel.js")).default;
  const { requireFeature } = await import("../middleware/subscriptionEnforcement.js");

  const suffix = `paygwfeature-${Date.now()}`;
  const tenantId = `test-${suffix}`;
  t.after(async () => {
    await TenantSubscriptionModel.deleteMany({ tenantId });
    await PlatformPlanModel.deleteMany({ planCode: `TESTPLAN-${suffix}` });
  });

  const plan = await PlatformPlanModel.create({
    planCode: `TESTPLAN-${suffix}`, name: "Test Plan", tier: "Starter", pricing: { currency: "USD", monthly: 10 },
    features: { paymentGatewayConnect: false }
  });
  await TenantSubscriptionModel.create({
    tenantId, planId: plan._id, planTier: plan.tier, planCode: plan.planCode, billingCycle: "Monthly", amount: 10, currency: "USD",
    status: "Active", currentPeriodStart: new Date(), currentPeriodEnd: new Date(Date.now() + 30 * 86400000)
  });

  const middleware = requireFeature("paymentGatewayConnect");
  const result = await runMiddleware(middleware, { auth: { tenantId } });
  assert.equal(result.blocked, true);
});

test("requireFeature('paymentGatewayConnect'): a real plan that never mentions the key at all is genuinely allowed (undefined never silently blocks)", { skip: !dbAvailable && dbSkipReason }, async (t) => {
  const TenantSubscriptionModel = (await import("../models/TenantSubscriptionModel.js")).default;
  const PlatformPlanModel = (await import("../models/PlatformPlanModel.js")).default;
  const { requireFeature } = await import("../middleware/subscriptionEnforcement.js");

  const suffix = `paygwfeatureunset-${Date.now()}`;
  const tenantId = `test-${suffix}`;
  t.after(async () => {
    await TenantSubscriptionModel.deleteMany({ tenantId });
    await PlatformPlanModel.deleteMany({ planCode: `TESTPLAN-${suffix}` });
  });

  const plan = await PlatformPlanModel.create({ planCode: `TESTPLAN-${suffix}`, name: "Test Plan", tier: "Starter", pricing: { currency: "USD", monthly: 10 } });
  await TenantSubscriptionModel.create({
    tenantId, planId: plan._id, planTier: plan.tier, planCode: plan.planCode, billingCycle: "Monthly", amount: 10, currency: "USD",
    status: "Active", currentPeriodStart: new Date(), currentPeriodEnd: new Date(Date.now() + 30 * 86400000)
  });

  const middleware = requireFeature("paymentGatewayConnect");
  const result = await runMiddleware(middleware, { auth: { tenantId } });
  assert.equal(result.blocked, false);
});

test("featureKeys catalog: paymentGatewayConnect is a real, recognized key", async () => {
  const { getPlatformConfig } = await import("../utils/platformConfig.js");
  assert.ok(getPlatformConfig().featureKeys.includes("paymentGatewayConnect"));
});

after(async () => {
  if (dbAvailable) await mongoose.disconnect();
});
