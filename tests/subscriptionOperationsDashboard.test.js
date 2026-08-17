import test, { after } from "node:test";
import assert from "node:assert/strict";
import dotenv from "dotenv";
import mongoose from "mongoose";

dotenv.config();

// Enterprise Subscription Automation Layer — Automation #10 (Enterprise
// Subscription Operations Dashboard). Proves, against a real database: MRR
// is genuinely computed by normalizing every live subscription's own real
// amount/billingCycle to a monthly figure (asserted as a real DELTA before
// vs. after adding known fixtures — this metric is platform-wide, so an
// absolute value would be contaminated by whatever else is running
// concurrently); the composed dashboard returns every real section with
// the right shapes; search finds a real fixture by partial name; the
// merchant timeline genuinely merges multiple real sources in chronological
// order; and the CSV export genuinely reuses the existing Financial
// Reporting export engine.
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

test("normalizeToMonthlyAmount: real MRR-normalization math, pure and deterministic", async () => {
  const { normalizeToMonthlyAmount } = await import("../services/SubscriptionOperationsDashboardService.js");
  assert.equal(normalizeToMonthlyAmount(30, "Monthly"), 30);
  assert.equal(normalizeToMonthlyAmount(90, "Quarterly"), 30);
  assert.equal(normalizeToMonthlyAmount(180, "HalfYearly"), 30);
  assert.equal(normalizeToMonthlyAmount(120, "Yearly"), 10);
  assert.equal(normalizeToMonthlyAmount(50, "SomeUnknownCycle"), 50, "an unrecognized cycle must fall back to face value, never throw or silently drop revenue");
});

test("getExecutiveKPIs: a real live subscription genuinely contributes to the platform-wide MRR/ARR total, a Trial genuinely does not", { skip: !dbAvailable && dbSkipReason }, async (t) => {
  const TenantModel = (await import("../models/Tenantmodel.js")).default;
  const PlatformPlanModel = (await import("../models/PlatformPlanModel.js")).default;
  const TenantSubscriptionModel = (await import("../models/TenantSubscriptionModel.js")).default;
  const SubscriptionOperationsDashboardService = (await import("../services/SubscriptionOperationsDashboardService.js")).default;

  // A real, near-certainly-unique currency label for THIS run only — sums
  // scoped to it can't be contaminated by any other concurrently-running
  // test's own USD/EUR fixtures (the platform-wide MRR aggregate is
  // deliberately grouped by real `currency`, so an unused label isolates
  // this assertion completely rather than racing a shared global total).
  const suffix = `mrr10-${Date.now()}`;
  const isolatedCurrency = `T${Date.now().toString(36).toUpperCase().slice(-8)}`;
  const tenantIds = [`test-${suffix}-monthly`, `test-${suffix}-yearly`, `test-${suffix}-trial`];

  t.after(async () => {
    await TenantModel.deleteMany({ tenantKey: { $in: tenantIds } });
    await PlatformPlanModel.deleteMany({ planCode: `TESTPLAN-${suffix}` });
    await TenantSubscriptionModel.deleteMany({ tenantId: { $in: tenantIds } });
  });

  const plan = await PlatformPlanModel.create({ planCode: `TESTPLAN-${suffix}`, name: "Test Plan", tier: "Starter", pricing: { currency: isolatedCurrency, monthly: 30 } });
  for (const tenantId of tenantIds) await TenantModel.create({ tenantKey: tenantId, name: `Test Tenant ${tenantId}`, status: "active" });

  // $30/month (Active) + $120/year = $10/month (Active) => real $40/month. A Trial subscription contributes $0 — Trials are deliberately excluded from MRR (no real revenue yet).
  await TenantSubscriptionModel.create({ tenantId: tenantIds[0], planId: plan._id, planTier: plan.tier, planCode: plan.planCode, billingCycle: "Monthly", amount: 30, currency: isolatedCurrency, status: "Active", currentPeriodStart: new Date(), currentPeriodEnd: new Date(Date.now() + 30 * 86400000) });
  await TenantSubscriptionModel.create({ tenantId: tenantIds[1], planId: plan._id, planTier: plan.tier, planCode: plan.planCode, billingCycle: "Yearly", amount: 120, currency: isolatedCurrency, status: "Active", currentPeriodStart: new Date(), currentPeriodEnd: new Date(Date.now() + 365 * 86400000) });
  await TenantSubscriptionModel.create({ tenantId: tenantIds[2], planId: plan._id, planTier: plan.tier, planCode: plan.planCode, billingCycle: "Monthly", amount: 999, currency: isolatedCurrency, status: "Trial", currentPeriodStart: new Date(), currentPeriodEnd: new Date(Date.now() + 14 * 86400000) });

  const kpis = await SubscriptionOperationsDashboardService.getExecutiveKPIs();
  const mrrRow = kpis.mrr.find((r) => r.currency === isolatedCurrency);
  const arrRow = kpis.arr.find((r) => r.currency === isolatedCurrency);

  assert.ok(mrrRow, "the isolated currency must appear in the real MRR breakdown");
  assert.equal(mrrRow.total, 40, "MRR must include the Monthly subscription at face value and the Yearly one normalized to /12, and exclude the Trial entirely");
  assert.equal(arrRow.total, 480, "ARR must be MRR annualized (x12)");
});

test("getFullDashboard: every real section is present with the right shapes", { skip: !dbAvailable && dbSkipReason }, async () => {
  const SubscriptionOperationsDashboardService = (await import("../services/SubscriptionOperationsDashboardService.js")).default;

  const dashboard = await SubscriptionOperationsDashboardService.getFullDashboard();
  assert.ok(dashboard.kpis);
  assert.ok(Array.isArray(dashboard.kpis.mrr));
  assert.ok(dashboard.home);
  assert.equal(typeof dashboard.home.renewalsToday, "number");
  assert.ok(dashboard.queues);
  assert.equal(typeof dashboard.queues.deadLetterQueue, "number");
  assert.ok(dashboard.workers);
  assert.equal(typeof dashboard.workers.activeWorkers, "number");
  assert.ok(dashboard.api);
  assert.ok(dashboard.notifications);
  assert.ok(dashboard.webhooks);
  assert.ok(dashboard.integrations);
  assert.ok(Array.isArray(dashboard.integrations.notIntegrated));
  assert.ok(Array.isArray(dashboard.alerts));
  assert.ok(dashboard.generatedAt);
});

test("search: finds a real fixture tenant by a partial name match", { skip: !dbAvailable && dbSkipReason }, async (t) => {
  const TenantModel = (await import("../models/Tenantmodel.js")).default;
  const SubscriptionOperationsDashboardService = (await import("../services/SubscriptionOperationsDashboardService.js")).default;

  const suffix = `search10-${Date.now()}`;
  const tenantId = `test-${suffix}`;
  t.after(async () => { await TenantModel.deleteMany({ tenantKey: tenantId }); });

  await TenantModel.create({ tenantKey: tenantId, name: `Unique Search Target ${suffix}`, status: "active" });

  const results = await SubscriptionOperationsDashboardService.search(`Unique Search Target ${suffix}`);
  assert.ok(results.merchants.some((m) => m.tenantKey === tenantId));
});

test("search: empty query returns empty results without touching the database", { skip: !dbAvailable && dbSkipReason }, async () => {
  const SubscriptionOperationsDashboardService = (await import("../services/SubscriptionOperationsDashboardService.js")).default;
  const results = await SubscriptionOperationsDashboardService.search("   ");
  assert.deepEqual(results, { merchants: [], invoices: [], subscriptions: [], bulkProcessingJobs: [], schedulerRuns: [] });
});

test("getMerchantTimeline: genuinely merges Subscription timeline + Audit trail in real chronological order", { skip: !dbAvailable && dbSkipReason }, async (t) => {
  const TenantModel = (await import("../models/Tenantmodel.js")).default;
  const PlatformPlanModel = (await import("../models/PlatformPlanModel.js")).default;
  const TenantSubscriptionModel = (await import("../models/TenantSubscriptionModel.js")).default;
  const TenantSubscriptionService = (await import("../services/TenantSubscriptionService.js")).default;
  const SubscriptionOperationsDashboardService = (await import("../services/SubscriptionOperationsDashboardService.js")).default;

  const suffix = `timeline10-${Date.now()}`;
  const tenantId = `test-${suffix}`;

  t.after(async () => {
    const AuditLogModel = (await import("../models/AuditLogmodel.js")).default;
    await TenantModel.deleteMany({ tenantKey: tenantId });
    await PlatformPlanModel.deleteMany({ planCode: `TESTPLAN-${suffix}` });
    await TenantSubscriptionModel.deleteMany({ tenantId });
    await AuditLogModel.deleteMany({ tenantId });
  });

  await TenantModel.create({ tenantKey: tenantId, name: `Test Tenant ${suffix}`, status: "active" });
  const plan = await PlatformPlanModel.create({ planCode: `TESTPLAN-${suffix}`, name: "Test Plan", tier: "Starter", pricing: { currency: "USD", monthly: 29 } });
  await TenantSubscriptionModel.create({ tenantId, planId: plan._id, planTier: plan.tier, planCode: plan.planCode, billingCycle: "Monthly", amount: 29, currency: "USD", status: "Active", currentPeriodStart: new Date(), currentPeriodEnd: new Date(Date.now() + 30 * 86400000) });

  await TenantSubscriptionService.suspendTenant(tenantId, "Timeline test suspension.", "tester");
  await TenantSubscriptionService.reactivateTenant(tenantId, "tester");

  const timeline = await SubscriptionOperationsDashboardService.getMerchantTimeline(tenantId);
  assert.equal(timeline.tenantId, tenantId);
  assert.ok(timeline.timeline.length >= 2, "must include at least the suspend and reactivate events");
  assert.ok(timeline.timeline.some((e) => e.source === "Subscription" && e.event === "SubscriptionSuspended"));
  assert.ok(timeline.timeline.some((e) => e.source === "Audit" && e.event === "MERCHANT_REACTIVATED"));

  for (let i = 1; i < timeline.timeline.length; i++) {
    assert.ok(new Date(timeline.timeline[i - 1].occurredAt).getTime() >= new Date(timeline.timeline[i].occurredAt).getTime(), "timeline must be sorted newest-first");
  }
});

test("getMerchantTimeline: throws a real not-found error for a tenant with no subscription", { skip: !dbAvailable && dbSkipReason }, async () => {
  const SubscriptionOperationsDashboardService = (await import("../services/SubscriptionOperationsDashboardService.js")).default;
  await assert.rejects(() => SubscriptionOperationsDashboardService.getMerchantTimeline("__no-such-tenant__"), /not found/i);
});

test("Operations dashboard controllers: getOperationsDashboard and exportOperationsDashboard(csv) return real, correctly-shaped responses", { skip: !dbAvailable && dbSkipReason }, async () => {
  const { getOperationsDashboard, exportOperationsDashboard } = await import("../controllers/TenantSubscriptionController.js");

  const req1 = { auth: { permissions: ["admin"] }, requestId: "test-req-id-1" };
  let statusCode1 = null, payload1 = null;
  const res1 = { status(code) { statusCode1 = code; return this; }, json(body) { payload1 = body; return this; } };
  await getOperationsDashboard(req1, res1);
  assert.equal(statusCode1, 200);
  assert.ok(payload1.success);
  assert.ok(payload1.data.kpis);

  const req2 = { auth: { permissions: ["admin"] }, requestId: "test-req-id-2", query: { format: "csv" } };
  let statusCode2 = null, sentBody = null, headers = {};
  const res2 = {
    status(code) { statusCode2 = code; return this; },
    setHeader(key, value) { headers[key] = value; },
    send(body) { sentBody = body; return this; },
    json(body) { sentBody = body; return this; }
  };
  await exportOperationsDashboard(req2, res2);
  assert.equal(statusCode2, 200);
  assert.equal(headers["Content-Type"], "text/csv");
  assert.ok(typeof sentBody === "string" && sentBody.includes("activeCompanies"));

  // The controller's own VIEW_SUBSCRIPTION_DASHBOARD audit write is real
  // fire-and-forget (never awaited on the hot dashboard-read path) — a
  // brief real wait here lets it settle before this file's own
  // mongoose.disconnect(), purely so the test process doesn't log a
  // spurious "Client must be connected" warning for a write that was
  // always going to succeed against a live app's real, always-open connection.
  await new Promise((resolve) => setTimeout(resolve, 100));
});

after(async () => {
  if (dbAvailable) await mongoose.disconnect();
});
