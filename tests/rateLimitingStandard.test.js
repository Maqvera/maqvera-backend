import test, { after } from "node:test";
import assert from "node:assert/strict";
import dotenv from "dotenv";
import mongoose from "mongoose";

dotenv.config();

// Enterprise Architecture Hardening Phase — API Rate Limiting & Throttling
// Standard (Improvement 13). Proves: real limit-resolution precedence
// (tenant rule -> platform rule -> config default, priority multiplier
// applied last), real atomic distributed counting with violation logged
// exactly once per bucket crossing, real burst detection, real abuse
// detection, real plan/merchant integration, the getApiCallCountToday <->
// checkRateLimit(daily window) relationship, registerRateLimitRule
// idempotency/change-event behavior, and the real Express middleware's
// header-setting/429-rejection behavior.
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

const makeReq = (overrides = {}) => ({
  auth: { tenantId: null, userId: null, permissions: [] },
  headers: {},
  header(name) { return this.headers[name.toLowerCase()] || null; },
  ip: "127.0.0.1",
  method: "GET",
  originalUrl: "/api/v1/test",
  baseUrl: "/api/v1",
  path: "/test",
  requestId: "corr-rl-1",
  ...overrides
});

const makeRes = () => ({
  statusCode: null,
  body: null,
  headers: {},
  status(code) { this.statusCode = code; return this; },
  json(body) { this.body = body; return this; },
  setHeader(name, value) { this.headers[name] = value; }
});

test("resolveLimit: config default -> platform-wide rule -> tenant-specific rule, priority multiplier applied on top", { skip: !dbAvailable && dbSkipReason }, async (t) => {
  const { resolveLimit } = await import("../utils/rateLimiter.js");
  const { registerRateLimitRule } = await import("../utils/rateLimitRules.js");
  const RateLimitRuleModel = (await import("../models/RateLimitRuleModel.js")).default;

  const tenantId = `TestTenantRL${Date.now()}`;
  const ruleKey = "reports";
  t.after(async () => { await RateLimitRuleModel.deleteMany({ ruleKey }); });

  const configDefault = await resolveLimit({ tenantId, scope: "User", ruleKey, priority: "Medium" });
  assert.equal(configDefault.limit, 1000, "falls back to the config's own User scope default (1000/hr) when no rule exists for an unrecognized ruleKey");

  await registerRateLimitRule(null, "User", ruleKey, { limit: 500, windowSeconds: 3600, owner: "Reports Platform" });
  const platformWide = await resolveLimit({ tenantId, scope: "User", ruleKey, priority: "Medium" });
  assert.equal(platformWide.limit, 500, "a platform-wide (tenantId: null) rule overrides the static config default");

  await registerRateLimitRule(tenantId, "User", ruleKey, { limit: 200, windowSeconds: 3600, owner: "Reports Platform" });
  const tenantSpecific = await resolveLimit({ tenantId, scope: "User", ruleKey, priority: "Medium" });
  assert.equal(tenantSpecific.limit, 200, "a tenant-specific rule takes precedence over the platform-wide one");

  const highPriority = await resolveLimit({ tenantId, scope: "User", ruleKey, priority: "High" });
  assert.equal(highPriority.limit, 300, "High priority applies its own 1.5x multiplier on top of the resolved 200 limit");

  const lowPriority = await resolveLimit({ tenantId, scope: "User", ruleKey, priority: "Low" });
  assert.equal(lowPriority.limit, 100, "Low priority applies its own 0.5x multiplier on top of the resolved 200 limit");
});

test("checkRateLimit: real atomic counting, request allowed under the limit, rejected once it's crossed, violation logged exactly once", { skip: !dbAvailable && dbSkipReason }, async (t) => {
  const { checkRateLimit } = await import("../utils/rateLimiter.js");
  const RateLimitViolationModel = (await import("../models/RateLimitViolationModel.js")).default;
  const RateLimitCounterModel = (await import("../models/RateLimitCounterModel.js")).default;

  const identifier = `test-user-${Date.now()}`;
  const scope = "User";
  t.after(async () => {
    await RateLimitViolationModel.deleteMany({ identifier });
    await RateLimitCounterModel.deleteMany({ bucketKey: new RegExp(identifier) });
  });

  const limit = 3;
  const windowSeconds = 3600;

  for (let i = 1; i <= limit; i++) {
    const result = await checkRateLimit({ scope, identifier, limit, windowSeconds });
    assert.equal(result.allowed, true, `request ${i} of ${limit} must be allowed`);
    assert.equal(result.count, i);
    assert.equal(result.remaining, limit - i);
  }

  const overLimit1 = await checkRateLimit({ scope, identifier, limit, windowSeconds, requestPath: "GET /api/v1/test" });
  assert.equal(overLimit1.allowed, false, "the request that crosses the limit must be rejected");
  assert.equal(overLimit1.remaining, 0);

  const overLimit2 = await checkRateLimit({ scope, identifier, limit, windowSeconds });
  assert.equal(overLimit2.allowed, false, "every subsequent request within the same bucket stays rejected");

  await new Promise((resolve) => setTimeout(resolve, 30)); // recordViolation's own audit/event writes are awaited inline, but give any background work a tick.
  const violations = await RateLimitViolationModel.find({ identifier }).lean();
  assert.equal(violations.length, 1, "a violation is recorded exactly once per bucket crossing, not once per over-limit request");
  assert.equal(violations[0].count, limit + 1);
});

test("checkBurst: a short-window spike above the burst ratio is detected exactly once", { skip: !dbAvailable && dbSkipReason }, async (t) => {
  const { checkBurst } = await import("../utils/rateLimiter.js");
  const RateLimitCounterModel = (await import("../models/RateLimitCounterModel.js")).default;
  const { publishVersionedEvent } = await import("../utils/eventVersioning.js");
  void publishVersionedEvent; // ensure module graph is warm before subscribing below

  const identifier = `test-burst-${Date.now()}`;
  const scope = "User";
  t.after(async () => { await RateLimitCounterModel.deleteMany({ bucketKey: new RegExp(identifier) }); });

  const { subscribeEvent } = await import("../utils/eventBus.js");
  let burstEvents = 0;
  subscribeEvent("BurstDetected.v1", () => { burstEvents += 1; });

  // The burst window is a real FIXED 10s window (utils/rateLimitConfig.js's
  // own burstWindowSeconds) keyed by wall-clock boundary, not a sliding
  // one — if the 12-call loop below happened to straddle a boundary
  // flip, the count would split across two buckets and might never
  // reach the burst threshold in either. Wait until just past a fresh
  // boundary so the whole loop (well under a second) runs inside one
  // window.
  const msIntoWindow = Date.now() % 10000;
  if (msIntoWindow > 5000) await new Promise((resolve) => setTimeout(resolve, 10000 - msIntoWindow + 50));

  const mainLimit = 100; // burstRatio 0.1 -> burstLimit 10
  for (let i = 0; i < 12; i++) {
    await checkBurst({ scope, identifier, mainLimit });
  }
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(burstEvents, 1, "BurstDetected.v1 fires exactly once, the moment the burst threshold is first crossed");
});

test("abuse detection: repeated violations for the same identifier publish AbuseDetected.v1", { skip: !dbAvailable && dbSkipReason }, async (t) => {
  const { checkRateLimit } = await import("../utils/rateLimiter.js");
  const RateLimitViolationModel = (await import("../models/RateLimitViolationModel.js")).default;
  const RateLimitCounterModel = (await import("../models/RateLimitCounterModel.js")).default;
  const { subscribeEvent } = await import("../utils/eventBus.js");

  const identifier = `test-abuse-${Date.now()}`;
  const scope = "IP";
  t.after(async () => {
    await RateLimitViolationModel.deleteMany({ identifier });
    await RateLimitCounterModel.deleteMany({ bucketKey: new RegExp(identifier) });
  });

  let abuseEvents = 0;
  subscribeEvent("AbuseDetected.v1", (payload) => {
    if (payload?.data?.identifier === identifier) abuseEvents += 1;
  });

  // abuseViolationThreshold defaults to 5 — cross a limit of 1, 5 separate
  // times, each against its own distinct ruleKey (-> its own distinct
  // counter bucket), so each iteration produces one genuine, separate
  // violation row for the SAME identifier.
  for (let i = 0; i < 5; i++) {
    const ruleKey = `abuse-probe-${i}`;
    await checkRateLimit({ scope, ruleKey, identifier, limit: 1, windowSeconds: 3600 }); // allowed
    await checkRateLimit({ scope, ruleKey, identifier, limit: 1, windowSeconds: 3600 }); // violates
  }

  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(abuseEvents, 1, "AbuseDetected.v1 fires once the violation count within the abuse window reaches the configured threshold");
});

test("resolvePlanApiLimit and resolveMerchantAccountId: real integration against TenantSubscriptionModel/PlatformPlanModel/TenantBillingAccountModel", { skip: !dbAvailable && dbSkipReason }, async (t) => {
  const { resolvePlanApiLimit, resolveMerchantAccountId } = await import("../utils/rateLimiter.js");
  const PlatformPlanModel = (await import("../models/PlatformPlanModel.js")).default;
  const TenantSubscriptionModel = (await import("../models/TenantSubscriptionModel.js")).default;
  const TenantBillingAccountModel = (await import("../models/TenantBillingAccountModel.js")).default;

  const tenantId = `TestTenantPlan${Date.now()}`;
  const planCode = `TESTPLAN${Date.now()}`;

  const noSubscription = await resolvePlanApiLimit(tenantId);
  assert.equal(noSubscription, null, "a tenant with no subscription row resolves to null (unlimited/uncapped), never a fabricated number");

  const plan = await PlatformPlanModel.create({
    planCode, name: "Test Plan", tier: "Professional",
    limits: { maxApiCallsPerDay: 50000 }
  });
  const subscription = await TenantSubscriptionModel.create({
    tenantId, planId: plan._id, planTier: "Professional", planCode,
    billingCycle: "Monthly", amount: 100, currency: "USD", status: "Active",
    currentPeriodStart: new Date(), currentPeriodEnd: new Date(Date.now() + 30 * 24 * 3600 * 1000)
  });
  const billingAccount = await TenantBillingAccountModel.create({
    tenantId, billingContactName: "Test Contact", billingContactEmail: "test@example.com",
    paymentMethod: "Manual", status: "Active"
  });

  t.after(async () => {
    await PlatformPlanModel.deleteOne({ _id: plan._id });
    await TenantSubscriptionModel.deleteOne({ _id: subscription._id });
    await TenantBillingAccountModel.deleteOne({ _id: billingAccount._id });
  });

  const resolved = await resolvePlanApiLimit(tenantId);
  assert.equal(resolved.limit, 50000);
  assert.equal(resolved.windowSeconds, 86400);
  assert.equal(resolved.planCode, planCode);

  const merchantAccountId = await resolveMerchantAccountId(tenantId);
  assert.equal(merchantAccountId, null, "no merchantAccountId was set on the billing account -> null, never a fabricated id");
});

test("getApiCallCountToday reads the SAME daily-window bucket a Tenant-scope, 86400-window checkRateLimit call writes to", { skip: !dbAvailable && dbSkipReason }, async (t) => {
  const { checkRateLimit, getApiCallCountToday } = await import("../utils/rateLimiter.js");
  const RateLimitCounterModel = (await import("../models/RateLimitCounterModel.js")).default;

  const tenantId = `TestTenantDaily${Date.now()}`;
  t.after(async () => { await RateLimitCounterModel.deleteMany({ bucketKey: new RegExp(tenantId) }); });

  const before = await getApiCallCountToday(tenantId);
  assert.equal(before, 0, "no daily Tenant-scope bucket exists yet");

  await checkRateLimit({ scope: "Tenant", identifier: tenantId, limit: 100000, windowSeconds: 86400, tenantId });
  await checkRateLimit({ scope: "Tenant", identifier: tenantId, limit: 100000, windowSeconds: 86400, tenantId });

  const after = await getApiCallCountToday(tenantId);
  assert.equal(after, 2, "getApiCallCountToday reads the exact count accumulated by a matching Tenant-scope, 86400-window checkRateLimit call");
});

test("registerRateLimitRule: idempotent same-value re-registration, real change publishes RateLimitConfigurationChanged.v1 exactly once", { skip: !dbAvailable && dbSkipReason }, async (t) => {
  const { registerRateLimitRule } = await import("../utils/rateLimitRules.js");
  const RateLimitRuleModel = (await import("../models/RateLimitRuleModel.js")).default;
  const { subscribeEvent } = await import("../utils/eventBus.js");

  const ruleKey = `test-rule-${Date.now()}`;
  t.after(async () => { await RateLimitRuleModel.deleteMany({ ruleKey }); });

  let changeEvents = 0;
  subscribeEvent("RateLimitConfigurationChanged.v1", (payload) => {
    if (payload?.data?.ruleKey === ruleKey) changeEvents += 1;
  });

  const first = await registerRateLimitRule(null, "Endpoint", ruleKey, { limit: 100, windowSeconds: 60, owner: "Test Owner" });
  assert.equal(first.limit, 100);

  const sameValue = await registerRateLimitRule(null, "Endpoint", ruleKey, { limit: 100, windowSeconds: 60, owner: "Test Owner" });
  assert.equal(String(sameValue._id), String(first._id));

  const changed = await registerRateLimitRule(null, "Endpoint", ruleKey, { limit: 250, windowSeconds: 60, owner: "Test Owner" });
  assert.equal(changed.limit, 250);

  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(changeEvents, 2, "RateLimitConfigurationChanged.v1 fires once on genuine creation and once on the genuine limit change — never for the same-value re-registration");
});

test("enterpriseRateLimit middleware: sets real X-RateLimit-* headers and calls next() while under the limit", { skip: !dbAvailable && dbSkipReason }, async (t) => {
  const { enterpriseRateLimit } = await import("../middleware/rateLimiter.js");
  const RateLimitCounterModel = (await import("../models/RateLimitCounterModel.js")).default;

  const tenantId = `TestTenantMwOk${Date.now()}`;
  t.after(async () => { await RateLimitCounterModel.deleteMany({ bucketKey: new RegExp(tenantId) }); });

  const req = makeReq({ auth: { tenantId, userId: "u1", permissions: [] } });
  const res = makeRes();
  let nextCalled = false;
  await enterpriseRateLimit({ scope: "Tenant" })(req, res, () => { nextCalled = true; });

  assert.equal(nextCalled, true);
  assert.equal(res.headers["X-RateLimit-Limit"], 100000);
  assert.equal(res.headers["X-RateLimit-Remaining"], 99999);
  assert.ok(res.headers["X-RateLimit-Reset"] > 0);
});

test("enterpriseRateLimit middleware: real 429 rejection with RATE_LIMITED code and Retry-After header once the limit is crossed — next() never called", { skip: !dbAvailable && dbSkipReason }, async (t) => {
  const { enterpriseRateLimit } = await import("../middleware/rateLimiter.js");
  const { registerRateLimitRule } = await import("../utils/rateLimitRules.js");
  const RateLimitCounterModel = (await import("../models/RateLimitCounterModel.js")).default;
  const RateLimitRuleModel = (await import("../models/RateLimitRuleModel.js")).default;
  const RateLimitViolationModel = (await import("../models/RateLimitViolationModel.js")).default;

  const tenantId = `TestTenantMwReject${Date.now()}`;
  const ruleKey = `mw-reject-${Date.now()}`;
  t.after(async () => {
    await RateLimitCounterModel.deleteMany({ bucketKey: new RegExp(tenantId) });
    await RateLimitRuleModel.deleteMany({ ruleKey });
    await RateLimitViolationModel.deleteMany({ identifier: tenantId });
  });

  await registerRateLimitRule(tenantId, "Tenant", ruleKey, { limit: 1, windowSeconds: 3600, owner: "Test Owner" });

  const middleware = enterpriseRateLimit({ scope: "Tenant", ruleKey });
  const req = makeReq({ auth: { tenantId, userId: "u1", permissions: [] } });

  const firstRes = makeRes();
  let firstNextCalled = false;
  await middleware(req, firstRes, () => { firstNextCalled = true; });
  assert.equal(firstNextCalled, true, "the first request is within the limit of 1");

  const secondRes = makeRes();
  let secondNextCalled = false;
  await middleware(req, secondRes, () => { secondNextCalled = true; });

  assert.equal(secondNextCalled, false, "the request that crosses the limit must be genuinely rejected, never fall through to the real handler");
  assert.equal(secondRes.statusCode, 429);
  assert.equal(secondRes.body.data.code, "RATE_LIMITED");
  assert.ok(secondRes.headers["Retry-After"] >= 1);
  assert.equal(secondRes.headers["X-RateLimit-Remaining"], 0);
});

test("enterpriseRateLimit middleware: fails open (calls next()) when the identifier for the requested scope can't be resolved", { skip: !dbAvailable && dbSkipReason }, async () => {
  const { enterpriseRateLimit } = await import("../middleware/rateLimiter.js");

  const req = makeReq({ auth: { tenantId: null, userId: null, permissions: [] } });
  const res = makeRes();
  let nextCalled = false;
  await enterpriseRateLimit({ scope: "Tenant" })(req, res, () => { nextCalled = true; });

  assert.equal(nextCalled, true, "an unauthenticated/tenant-less request must never be blocked by a scope it can't even identify");
  assert.deepEqual(res.headers, {}, "no rate-limit headers are fabricated when the scope's identifier couldn't be resolved");
});

after(async () => {
  if (dbAvailable) await mongoose.disconnect();
});
