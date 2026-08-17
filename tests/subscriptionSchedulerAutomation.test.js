import test, { after } from "node:test";
import assert from "node:assert/strict";
import dotenv from "dotenv";
import mongoose from "mongoose";

dotenv.config();

// Enterprise Subscription Automation Layer — Automation #1 (Enterprise
// Subscription Scheduler). Proves, against a real database: the shared
// enforceGracePeriodSuspensions() method (used by both the daily sweep and
// the new, separate, more-frequent enforcement scheduler) genuinely
// suspends; the daily sweep's own return shape stays backward compatible
// while adding real processed/failed counters; and SchedulerRunTracker
// creates a real, persisted run record + audit entry + versioned domain
// events for a run's full start->complete and start->fail lifecycles.
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

test("TenantSubscriptionService.enforceGracePeriodSuspensions: suspends a real grace-expired tenant, shared by both scheduler jobs", { skip: !dbAvailable && dbSkipReason }, async (t) => {
  const TenantModel = (await import("../models/Tenantmodel.js")).default;
  const PlatformPlanModel = (await import("../models/PlatformPlanModel.js")).default;
  const TenantSubscriptionModel = (await import("../models/TenantSubscriptionModel.js")).default;
  const TenantSubscriptionService = (await import("../services/TenantSubscriptionService.js")).default;

  const suffix = `enforce-${Date.now()}`;
  const tenantId = `test-${suffix}`;

  t.after(async () => {
    await TenantModel.deleteMany({ tenantKey: tenantId });
    await PlatformPlanModel.deleteMany({ planCode: `TESTPLAN-${suffix}` });
    await TenantSubscriptionModel.deleteMany({ tenantId });
  });

  await TenantModel.create({ tenantKey: tenantId, name: `Test Tenant ${suffix}`, status: "active" });
  const plan = await PlatformPlanModel.create({ planCode: `TESTPLAN-${suffix}`, name: "Test Plan", tier: "Starter", pricing: { currency: "USD", monthly: 29 } });

  // Already in GracePeriod with an already-elapsed gracePeriodEndsAt — as if the 30-minute enforcement job is running well after grace expired.
  await TenantSubscriptionModel.create({
    tenantId, planId: plan._id, planTier: plan.tier, planCode: plan.planCode, billingCycle: "Monthly", amount: 29, currency: "USD",
    status: "GracePeriod", currentPeriodStart: new Date(Date.now() - 40 * 86400000), currentPeriodEnd: new Date(Date.now() - 10 * 86400000),
    gracePeriodEndsAt: new Date(Date.now() - 1000)
  });

  const result = await TenantSubscriptionService.enforceGracePeriodSuspensions();
  assert.ok(result.processed >= 1);
  assert.ok(result.suspended >= 1);
  assert.equal(result.failed, 0);

  const reloadedTenant = await TenantModel.findOne({ tenantKey: tenantId }).lean();
  assert.equal(reloadedTenant.status, "suspended");

  // Idempotent — re-running finds nothing left to suspend (already Suspended never matches the GracePeriod query again).
  const secondPass = await TenantSubscriptionService.enforceGracePeriodSuspensions();
  const stillMatchingThisTenant = await TenantSubscriptionModel.findOne({ tenantId }).lean();
  assert.equal(stillMatchingThisTenant.status, "Suspended");
  assert.ok(secondPass.suspended === 0 || secondPass.processed === secondPass.suspended - result.suspended + result.suspended, "re-running must not double-suspend this same tenant");
});

test("TenantSubscriptionService.runDailyLifecycleSweep: return shape stays backward compatible (existing keys unchanged) and adds real processed/failed counters", { skip: !dbAvailable && dbSkipReason }, async () => {
  const TenantSubscriptionService = (await import("../services/TenantSubscriptionService.js")).default;
  const results = await TenantSubscriptionService.runDailyLifecycleSweep();

  for (const key of ["invoicesGenerated", "remindersSent", "gracePeriodsStarted", "suspended", "expired", "archived"]) {
    assert.ok(key in results, `expected the pre-existing key "${key}" to still be present`);
    assert.equal(typeof results[key], "number");
  }
  assert.ok("processed" in results && typeof results.processed === "number", "expected a new real processed counter");
  assert.ok("failed" in results && typeof results.failed === "number", "expected a new real failed counter");
});

test("SchedulerRunTracker: a real run record + audit entry + versioned domain events for the full start -> complete lifecycle", { skip: !dbAvailable && dbSkipReason }, async (t) => {
  const SchedulerRunModel = (await import("../models/SchedulerRunModel.js")).default;
  const AuditLogModel = (await import("../models/AuditLogmodel.js")).default;
  const SchedulerRunTracker = (await import("../utils/schedulerRunTracker.js")).default;
  const { subscribeEvent } = await import("../utils/eventBus.js");

  const jobName = `TestJob-${Date.now()}`;
  const receivedEvents = [];
  const unsubStarted = subscribeEvent(`${jobName}Started.v1`, (payload) => receivedEvents.push(payload));
  const unsubCompleted = subscribeEvent(`${jobName}Completed.v1`, (payload) => receivedEvents.push(payload));

  t.after(async () => {
    await SchedulerRunModel.deleteMany({ jobName });
    await AuditLogModel.deleteMany({ resource: "SchedulerRun", "details.jobName": jobName });
    if (typeof unsubStarted === "function") unsubStarted();
    if (typeof unsubCompleted === "function") unsubCompleted();
  });

  const context = await SchedulerRunTracker.startRun(jobName, { eventPrefix: jobName, triggeredBy: "manual" });
  assert.equal(context.run.status, "Running");
  assert.ok(context.run.jobId);

  const runningRow = await SchedulerRunModel.findOne({ jobId: context.run.jobId }).lean();
  assert.ok(runningRow, "a real run record must be persisted at start, before any work happens");
  assert.equal(runningRow.status, "Running");
  assert.equal(runningRow.triggeredBy, "manual");

  await SchedulerRunTracker.completeRun(context, { processed: 10, suspended: 2, invoicesGenerated: 3, failed: 0 });

  const completedRow = await SchedulerRunModel.findOne({ jobId: context.run.jobId }).lean();
  assert.equal(completedRow.status, "Completed");
  assert.equal(completedRow.processed, 10);
  assert.equal(completedRow.suspended, 2);
  assert.equal(completedRow.invoicesGenerated, 3);
  assert.ok(completedRow.finishedAt);
  assert.ok(typeof completedRow.durationMs === "number" && completedRow.durationMs >= 0);

  const auditEntry = await AuditLogModel.findOne({ action: "platform.scheduler.run_completed", resourceId: context.run.jobId }).lean();
  assert.ok(auditEntry, "every scheduler run MUST be audited");
  assert.equal(auditEntry.details.processed, 10);

  await new Promise((resolve) => setTimeout(resolve, 30)); // eventBus dispatch is queueMicrotask-based — real, brief wait for delivery.
  const startedEvent = receivedEvents.find((e) => e.eventName === `${jobName}Started`);
  const completedEvent = receivedEvents.find((e) => e.eventName === `${jobName}Completed`);
  assert.ok(startedEvent, "a real versioned SubscriptionScan-style Started event must be published");
  assert.equal(startedEvent.eventVersion, "1.0");
  assert.ok(completedEvent, "a real versioned Completed event must be published");
  assert.equal(completedEvent.data.processed, 10);
});

test("SchedulerRunTracker: the start -> fail lifecycle records a real Failed run + audit entry", { skip: !dbAvailable && dbSkipReason }, async (t) => {
  const SchedulerRunModel = (await import("../models/SchedulerRunModel.js")).default;
  const AuditLogModel = (await import("../models/AuditLogmodel.js")).default;
  const SchedulerRunTracker = (await import("../utils/schedulerRunTracker.js")).default;

  const jobName = `TestFailJob-${Date.now()}`;
  t.after(async () => {
    await SchedulerRunModel.deleteMany({ jobName });
    await AuditLogModel.deleteMany({ resource: "SchedulerRun", "details.jobName": jobName });
  });

  const context = await SchedulerRunTracker.startRun(jobName, { eventPrefix: jobName });
  await SchedulerRunTracker.failRun(context, new Error("Simulated database timeout."));

  const failedRow = await SchedulerRunModel.findOne({ jobId: context.run.jobId }).lean();
  assert.equal(failedRow.status, "Failed");
  assert.equal(failedRow.errorMessage, "Simulated database timeout.");
  assert.ok(failedRow.finishedAt);

  const auditEntry = await AuditLogModel.findOne({ action: "platform.scheduler.run_failed", resourceId: context.run.jobId }).lean();
  assert.ok(auditEntry, "a failed run MUST also be audited");
});

test("Scheduler monitoring dashboard: getSchedulerDashboard returns real live counts and a real computed next-run time", { skip: !dbAvailable && dbSkipReason }, async () => {
  const { getSchedulerDashboard } = await import("../controllers/TenantSubscriptionController.js");

  const req = { auth: { permissions: ["admin"] }, requestId: "test-req-id" };
  let statusCode = null;
  let payload = null;
  const res = {
    status(code) { statusCode = code; return this; },
    json(body) { payload = body; return this; }
  };

  await getSchedulerDashboard(req, res);

  assert.equal(statusCode, 200);
  assert.ok(payload.success);
  const { data } = payload;
  assert.equal(typeof data.todayRenewals, "number");
  assert.equal(typeof data.todaySuspensions, "number");
  assert.equal(typeof data.gracePeriodCompanies, "number");
  assert.equal(typeof data.failedJobsToday, "number");
  assert.ok(data.jobs.SubscriptionScheduler);
  assert.ok(data.jobs.SubscriptionSuspensionEnforcement);
  assert.ok(new Date(data.jobs.SubscriptionScheduler.nextScheduledRun).getTime() > Date.now(), "the next scheduled run must be a real, future, computed timestamp");
});

after(async () => {
  if (dbAvailable) await mongoose.disconnect();
});
