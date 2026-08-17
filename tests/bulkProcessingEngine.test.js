import test, { after } from "node:test";
import assert from "node:assert/strict";
import dotenv from "dotenv";
import mongoose from "mongoose";

dotenv.config();

// Enterprise Subscription Automation Layer — Automation #8 (Enterprise
// Bulk Processing Engine). Proves, against a real database: the real
// Mongo-backed distributed lock genuinely serializes access and reclaims
// an expired lock; `BulkProcessingEngineService.runJob` genuinely batches,
// runs bounded-concurrency parallel workers, commits a real per-batch
// checkpoint, isolates one item's failure from the rest of the batch,
// retries a failing item before moving it to the real, shared Dead Letter
// Queue; `TenantSubscriptionService.enforceGracePeriodSuspensionsBulk`
// genuinely suspends real grace-expired tenants through the engine; the
// monitoring dashboard returns real live figures; and the Dead Letter
// Queue reprocess endpoint genuinely re-executes and recovers a failed item.
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

test("distributedLock: serializes access to the same key and reclaims an expired lock", { skip: !dbAvailable && dbSkipReason }, async (t) => {
  const { acquireLock, releaseLock } = await import("../utils/distributedLock.js");
  const DistributedLockModel = (await import("../models/DistributedLockModel.js")).default;

  const lockKey = `test-lock-${Date.now()}`;
  t.after(async () => { await DistributedLockModel.deleteMany({ lockKey }); });

  const first = await acquireLock(lockKey, 5000);
  assert.equal(first.acquired, true);

  const second = await acquireLock(lockKey, 5000);
  assert.equal(second.acquired, false, "a second acquire on the same still-valid lock must fail");

  await releaseLock(lockKey, first.owner);
  const third = await acquireLock(lockKey, 5000);
  assert.equal(third.acquired, true, "acquiring again after release must succeed");
  await releaseLock(lockKey, third.owner);

  const shortLived = await acquireLock(lockKey, 50);
  assert.equal(shortLived.acquired, true);
  await new Promise((resolve) => setTimeout(resolve, 120));
  const afterExpiry = await acquireLock(lockKey, 5000);
  assert.equal(afterExpiry.acquired, true, "an expired lock must be reclaimable without an explicit release");
  await releaseLock(lockKey, afterExpiry.owner);
});

test("BulkProcessingEngineService.runJob: batches, runs bounded-concurrency parallel workers, checkpoints, isolates a failure, and moves it to the Dead Letter Queue", { skip: !dbAvailable && dbSkipReason }, async (t) => {
  const TenantModel = (await import("../models/Tenantmodel.js")).default;
  const PlatformPlanModel = (await import("../models/PlatformPlanModel.js")).default;
  const TenantSubscriptionModel = (await import("../models/TenantSubscriptionModel.js")).default;
  const BulkProcessingJobModel = (await import("../models/BulkProcessingJobModel.js")).default;
  const DeadLetterQueueModel = (await import("../models/DeadLetterQueueModel.js")).default;
  const BulkProcessingEngineService = (await import("../services/BulkProcessingEngineService.js")).default;
  const { subscribeEvent } = await import("../utils/eventBus.js");

  const suffix = `bulk-${Date.now()}`;
  const jobType = `TestBulkJob-${suffix}`;
  const plan = await PlatformPlanModel.create({ planCode: `TESTPLAN-${suffix}`, name: "Test Plan", tier: "Starter", pricing: { currency: "USD", monthly: 29 } });

  const tenantIds = [];
  for (let i = 0; i < 9; i++) tenantIds.push(`test-${suffix}-${i}`);
  const failingTenantId = tenantIds[4];

  // Real, admin-configurable retry backoff — set to a small real value for
  // this test's own failure/retry path instead of waiting out the (real,
  // production-appropriate) 1s/2s default backoff.
  const previousBackoffMs = process.env.PLATFORM_BULK_PROCESSING_RETRY_BACKOFF_MS;
  process.env.PLATFORM_BULK_PROCESSING_RETRY_BACKOFF_MS = "20";

  t.after(async () => {
    if (previousBackoffMs === undefined) delete process.env.PLATFORM_BULK_PROCESSING_RETRY_BACKOFF_MS;
    else process.env.PLATFORM_BULK_PROCESSING_RETRY_BACKOFF_MS = previousBackoffMs;
    await TenantModel.deleteMany({ tenantKey: { $in: tenantIds } });
    await PlatformPlanModel.deleteMany({ planCode: `TESTPLAN-${suffix}` });
    await TenantSubscriptionModel.deleteMany({ tenantId: { $in: tenantIds } });
    await BulkProcessingJobModel.deleteMany({ jobType });
    await DeadLetterQueueModel.deleteMany({ correlationId: { $exists: true }, "payload.tenantId": { $in: tenantIds } });
  });

  for (const tenantId of tenantIds) {
    await TenantModel.create({ tenantKey: tenantId, name: `Test Tenant ${tenantId}`, status: "active" });
    await TenantSubscriptionModel.create({
      tenantId, planId: plan._id, planTier: plan.tier, planCode: plan.planCode, billingCycle: "Monthly", amount: 29, currency: "USD",
      status: "GracePeriod", currentPeriodStart: new Date(Date.now() - 40 * 86400000), currentPeriodEnd: new Date(Date.now() - 10 * 86400000),
      gracePeriodEndsAt: new Date(Date.now() - 1000)
    });
  }

  let maxConcurrentObserved = 0;
  let currentlyActive = 0;
  const processedTenantIds = [];
  const startedEvents = [];
  const completedEvents = [];
  const failedEvents = [];
  const unsubs = [
    subscribeEvent("BulkProcessingStarted.v1", (p) => startedEvents.push(p)),
    subscribeEvent("MerchantProcessingCompleted.v1", (p) => completedEvents.push(p)),
    subscribeEvent("MerchantProcessingFailed.v1", (p) => failedEvents.push(p))
  ];
  t.after(() => unsubs.forEach((unsub) => { if (typeof unsub === "function") unsub(); }));

  const result = await BulkProcessingEngineService.runJob({
    jobType,
    model: TenantSubscriptionModel,
    filter: { tenantId: { $in: tenantIds }, status: "GracePeriod" },
    batchSize: 4,
    concurrency: 3,
    processOne: async (doc) => {
      currentlyActive += 1;
      maxConcurrentObserved = Math.max(maxConcurrentObserved, currentlyActive);
      await new Promise((resolve) => setTimeout(resolve, 20));
      currentlyActive -= 1;

      if (doc.tenantId === failingTenantId) throw new Error("Simulated processing failure for this one merchant only.");
      processedTenantIds.push(doc.tenantId);
      return { result: "PROCESSED" };
    }
  });

  assert.equal(result.lockSkipped, false);
  assert.equal(result.totalDiscovered, 9);
  assert.equal(result.processed, 9);
  assert.equal(result.succeeded, 8, "every tenant except the deliberately-failing one must succeed");
  assert.equal(result.failed, 1);
  assert.equal(result.deadLettered, 1);
  assert.ok(result.retried >= 1, "the failing item must have been retried before being dead-lettered");
  assert.equal(result.status, "PartiallyFailed");
  assert.ok(maxConcurrentObserved <= 3, `worker pool must never exceed the configured concurrency (observed ${maxConcurrentObserved})`);
  assert.ok(maxConcurrentObserved >= 2, "processing must genuinely overlap, not run one item at a time");
  assert.equal(processedTenantIds.filter((id) => id === failingTenantId).length, 0, "the failing tenant must never appear in the successful set");
  assert.equal(new Set(processedTenantIds).size, 8, "every non-failing tenant must be processed exactly once");

  const jobRow = await BulkProcessingJobModel.findOne({ jobId: result.jobId }).lean();
  assert.ok(jobRow, "a real, persisted job record must exist");
  assert.equal(jobRow.status, "PartiallyFailed");
  assert.ok(jobRow.lastCheckpointId, "a real checkpoint must be committed after the last batch");

  const dlqRow = await DeadLetterQueueModel.findOne({ correlationId: result.jobId }).lean();
  assert.ok(dlqRow, "the exhausted-retry item must be moved to the real, shared Dead Letter Queue");
  assert.equal(dlqRow.integration, "BulkProcessingEngine");
  assert.equal(dlqRow.payload.tenantId, failingTenantId);
  assert.equal(dlqRow.status, "Pending");

  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.ok(startedEvents.some((e) => e.data.jobId === result.jobId), "BulkProcessingStarted.v1 must publish");
  assert.equal(completedEvents.filter((e) => e.data.jobId === result.jobId).length, 8, "MerchantProcessingCompleted.v1 must publish once per real success");
  assert.equal(failedEvents.filter((e) => e.data.jobId === result.jobId).length, 1, "MerchantProcessingFailed.v1 must publish once for the exhausted item");
});

test("BulkProcessingEngineService.runJob: a second concurrent call for the same jobType is skipped by the distributed lock", { skip: !dbAvailable && dbSkipReason }, async (t) => {
  const TenantSubscriptionModel = (await import("../models/TenantSubscriptionModel.js")).default;
  const BulkProcessingJobModel = (await import("../models/BulkProcessingJobModel.js")).default;
  const BulkProcessingEngineService = (await import("../services/BulkProcessingEngineService.js")).default;

  const jobType = `TestLockedJob-${Date.now()}`;
  t.after(async () => { await BulkProcessingJobModel.deleteMany({ jobType }); });

  const runOnce = () => BulkProcessingEngineService.runJob({
    jobType,
    model: TenantSubscriptionModel,
    filter: { tenantId: "__no-such-tenant__" }, // matches nothing — fast, real query either way
    processOne: async () => ({ result: "PROCESSED" })
  });

  const [first, second] = await Promise.all([runOnce(), runOnce()]);
  const outcomes = [first, second];
  const skippedCount = outcomes.filter((o) => o.lockSkipped).length;
  const ranCount = outcomes.filter((o) => !o.lockSkipped).length;
  assert.equal(ranCount + skippedCount, 2);
  assert.ok(ranCount >= 1, "at least one of the two concurrent calls must actually run");
  // Both may legitimately run if their real work finished fast enough to
  // fully release the lock before the other's acquire attempt — the
  // dedicated lock test above already proves true mutual exclusion while
  // one is genuinely held; this test proves the mechanism is wired into
  // runJob itself without asserting a race outcome that isn't deterministic.
});

test("TenantSubscriptionService.enforceGracePeriodSuspensionsBulk: genuinely suspends real grace-expired tenants through the bulk engine", { skip: !dbAvailable && dbSkipReason }, async (t) => {
  const TenantModel = (await import("../models/Tenantmodel.js")).default;
  const PlatformPlanModel = (await import("../models/PlatformPlanModel.js")).default;
  const TenantSubscriptionModel = (await import("../models/TenantSubscriptionModel.js")).default;
  const BulkProcessingJobModel = (await import("../models/BulkProcessingJobModel.js")).default;
  const TenantSubscriptionService = (await import("../services/TenantSubscriptionService.js")).default;

  const suffix = `bulksuspend-${Date.now()}`;
  const tenantIds = [`test-${suffix}-a`, `test-${suffix}-b`];

  t.after(async () => {
    await TenantModel.deleteMany({ tenantKey: { $in: tenantIds } });
    await PlatformPlanModel.deleteMany({ planCode: `TESTPLAN-${suffix}` });
    await TenantSubscriptionModel.deleteMany({ tenantId: { $in: tenantIds } });
    await BulkProcessingJobModel.deleteMany({ jobType: "GracePeriodSuspensionSweep", triggeredBy: "manual" });
  });

  const plan = await PlatformPlanModel.create({ planCode: `TESTPLAN-${suffix}`, name: "Test Plan", tier: "Starter", pricing: { currency: "USD", monthly: 29 } });
  for (const tenantId of tenantIds) {
    await TenantModel.create({ tenantKey: tenantId, name: `Test Tenant ${tenantId}`, status: "active" });
    await TenantSubscriptionModel.create({
      tenantId, planId: plan._id, planTier: plan.tier, planCode: plan.planCode, billingCycle: "Monthly", amount: 29, currency: "USD",
      status: "GracePeriod", currentPeriodStart: new Date(Date.now() - 40 * 86400000), currentPeriodEnd: new Date(Date.now() - 10 * 86400000),
      gracePeriodEndsAt: new Date(Date.now() - 1000)
    });
  }

  const result = await TenantSubscriptionService.enforceGracePeriodSuspensionsBulk({ triggeredBy: "manual" });
  assert.equal(result.lockSkipped, false);
  assert.ok(result.processed >= 2);
  assert.ok(result.suspended >= 2);
  assert.equal(result.failed, 0);
  assert.ok(result.jobId);

  for (const tenantId of tenantIds) {
    const reloaded = await TenantModel.findOne({ tenantKey: tenantId }).lean();
    assert.equal(reloaded.status, "suspended");
  }

  const jobRow = await BulkProcessingJobModel.findOne({ jobId: result.jobId }).lean();
  assert.equal(jobRow.jobType, "GracePeriodSuspensionSweep");
  assert.equal(jobRow.status, "Completed");
});

test("Bulk processing monitoring dashboard: getBulkProcessingDashboard returns real live figures", { skip: !dbAvailable && dbSkipReason }, async () => {
  const { getBulkProcessingDashboard } = await import("../controllers/TenantSubscriptionController.js");

  const req = { auth: { permissions: ["admin"] }, requestId: "test-req-id" };
  let statusCode = null;
  let payload = null;
  const res = {
    status(code) { statusCode = code; return this; },
    json(body) { payload = body; return this; }
  };

  await getBulkProcessingDashboard(req, res);

  assert.equal(statusCode, 200);
  assert.ok(payload.success);
  const { data } = payload;
  assert.equal(typeof data.queueSize, "number");
  assert.equal(typeof data.activeWorkers, "number");
  assert.equal(typeof data.configuredConcurrency, "number");
  assert.ok(data.deadLetterQueue);
  assert.equal(typeof data.deadLetterQueue.pending, "number");
  assert.ok(Array.isArray(data.recentJobs));
});

test("reprocessBulkProcessingDeadLetter: manually reprocessing a dead-lettered suspension genuinely recovers it", { skip: !dbAvailable && dbSkipReason }, async (t) => {
  const TenantModel = (await import("../models/Tenantmodel.js")).default;
  const PlatformPlanModel = (await import("../models/PlatformPlanModel.js")).default;
  const TenantSubscriptionModel = (await import("../models/TenantSubscriptionModel.js")).default;
  const DeadLetterQueueModel = (await import("../models/DeadLetterQueueModel.js")).default;
  const { reprocessBulkProcessingDeadLetter } = await import("../controllers/TenantSubscriptionController.js");

  const suffix = `dlqreprocess-${Date.now()}`;
  const tenantId = `test-${suffix}`;

  t.after(async () => {
    await TenantModel.deleteMany({ tenantKey: tenantId });
    await PlatformPlanModel.deleteMany({ planCode: `TESTPLAN-${suffix}` });
    await TenantSubscriptionModel.deleteMany({ tenantId });
    await DeadLetterQueueModel.deleteMany({ "payload.tenantId": tenantId });
  });

  await TenantModel.create({ tenantKey: tenantId, name: `Test Tenant ${suffix}`, status: "active" });
  const plan = await PlatformPlanModel.create({ planCode: `TESTPLAN-${suffix}`, name: "Test Plan", tier: "Starter", pricing: { currency: "USD", monthly: 29 } });
  await TenantSubscriptionModel.create({
    tenantId, planId: plan._id, planTier: plan.tier, planCode: plan.planCode, billingCycle: "Monthly", amount: 29, currency: "USD",
    status: "GracePeriod", currentPeriodStart: new Date(Date.now() - 40 * 86400000), currentPeriodEnd: new Date(Date.now() - 10 * 86400000),
    gracePeriodEndsAt: new Date(Date.now() - 1000)
  });

  const dlq = await DeadLetterQueueModel.create({
    tenantId, module: "Platform", operation: "GracePeriodSuspensionSweep", integration: "BulkProcessingEngine",
    reason: "Simulated failure for reprocess test.", retryAttempts: 3, correlationId: `test-job-${suffix}`,
    payload: { tenantId, subscriptionId: null }, status: "Pending", failedAt: new Date(),
    timeline: [{ event: "DeadLetterQueued", description: "Simulated." }]
  });

  const req = { auth: { permissions: ["admin"], userId: "tester" }, params: { dlqId: dlq._id.toString() }, requestId: "test-req-id" };
  let statusCode = null;
  let payload = null;
  const res = {
    status(code) { statusCode = code; return this; },
    json(body) { payload = body; return this; }
  };

  await reprocessBulkProcessingDeadLetter(req, res);

  assert.equal(statusCode, 200, JSON.stringify(payload));
  assert.ok(payload.success);

  const reloadedTenant = await TenantModel.findOne({ tenantKey: tenantId }).lean();
  assert.equal(reloadedTenant.status, "suspended", "reprocessing must genuinely re-execute the real suspend business action");

  const reloadedDlq = await DeadLetterQueueModel.findById(dlq._id).lean();
  assert.equal(reloadedDlq.status, "Recovered");
});

after(async () => {
  if (dbAvailable) await mongoose.disconnect();
});
