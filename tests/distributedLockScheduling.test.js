import test, { after } from "node:test";
import assert from "node:assert/strict";
import dotenv from "dotenv";
import mongoose from "mongoose";

dotenv.config();

// Production Readiness Audit — Phase 1 / Item 1 (scheduler duplication
// under horizontal scaling). Every one of the 31 services/*Scheduler.js
// cron callbacks now wraps its job body in
// utils/distributedLock.js#withDistributedLock, keyed "scheduler:<Name>"
// (see .env.example's new SCHEDULER_LOCK_TTL_MS and
// utils/schedulerLockConfig.js). This test proves the actual mechanism
// every one of those 31 wrappers relies on: two "instances" racing the
// same lock key concurrently (simulating 2 app replicas hitting the same
// cron tick at the same moment) — exactly one must actually run the job,
// the other must observe {skipped: true} and never execute its callback.
// Also proves lock keys are independent (two different schedulers never
// block each other) and that a genuinely expired lock is reclaimed (a
// crashed instance's stale lock must not wedge a job forever).

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

test("Scheduler distributed locking: 2 concurrent 'instances' racing the same job -> exactly one runs; independent lock keys never block each other; a stale lock is reclaimed", { skip: !dbAvailable && dbSkipReason }, async (t) => {
  const { withDistributedLock, acquireLock, releaseLock } = await import("../utils/distributedLock.js");
  const { getSchedulerLockConfig } = await import("../utils/schedulerLockConfig.js");
  const DistributedLockModel = (await import("../models/DistributedLockModel.js")).default;

  const suffix = Date.now();
  const lockKeyA = `scheduler:TestSchedulerA-${suffix}`;
  const lockKeyB = `scheduler:TestSchedulerB-${suffix}`;

  t.after(async () => {
    await DistributedLockModel.deleteMany({ lockKey: { $in: [lockKeyA, lockKeyB] } });
  });

  // ---- getSchedulerLockConfig: the shared, env-configurable TTL every scheduler uses ----
  assert.equal(getSchedulerLockConfig().defaultLockTtlMs, 600000, "default TTL must match .env.example's documented SCHEDULER_LOCK_TTL_MS default");

  // ---- Core scenario: 2 "instances" (2 concurrent calls with the SAME lock key) racing the same cron tick ----
  let executionCount = 0;
  const simulatedJob = async () => {
    executionCount += 1;
    await new Promise((resolve) => setTimeout(resolve, 150)); // hold the lock long enough for the race to be real, not just a fast no-op
    return "job ran";
  };

  const [outcomeA, outcomeB] = await Promise.all([
    withDistributedLock(lockKeyA, 10000, simulatedJob),
    withDistributedLock(lockKeyA, 10000, simulatedJob)
  ]);

  const results = [outcomeA, outcomeB];
  const skippedCount = results.filter((r) => r.skipped).length;
  const ranCount = results.filter((r) => !r.skipped).length;
  assert.equal(skippedCount, 1, "exactly one of the two concurrent 'instances' must be skipped — this is what prevents a cron job firing N times across N replicas");
  assert.equal(ranCount, 1, "exactly one of the two concurrent 'instances' must actually run the job");
  assert.equal(executionCount, 1, "the job body itself must genuinely execute only once, not twice");

  // ---- After the winner releases, the lock is free again — a later, real solo tick isn't permanently blocked ----
  const afterRelease = await withDistributedLock(lockKeyA, 10000, simulatedJob);
  assert.equal(afterRelease.skipped, false, "the lock must be released after the winning run completes, so the NEXT real tick can still run");
  assert.equal(executionCount, 2);

  // ---- Independent lock keys (different schedulers) never block each other ----
  let jobBExecuted = false;
  const { acquired: heldA } = await acquireLock(lockKeyA, 10000, "held-by-test");
  assert.equal(heldA, true);
  const outcomeIndependent = await withDistributedLock(lockKeyB, 10000, async () => { jobBExecuted = true; });
  assert.equal(outcomeIndependent.skipped, false, "a different scheduler's lock key must never be blocked by an unrelated scheduler's held lock");
  assert.equal(jobBExecuted, true);
  await releaseLock(lockKeyA, "held-by-test");

  // ---- A stale (expired) lock is reclaimed, not wedged forever (a crashed instance must not permanently block this job) ----
  await DistributedLockModel.create({ lockKey: lockKeyA, lockedBy: "crashed-instance", acquiredAt: new Date(Date.now() - 20000), expiresAt: new Date(Date.now() - 10000) });
  const reclaimResult = await withDistributedLock(lockKeyA, 10000, async () => "reclaimed");
  assert.equal(reclaimResult.skipped, false, "an expired lock left behind by a crashed instance must be reclaimable by a healthy instance's next tick");
  assert.equal(reclaimResult.result, "reclaimed");
});

after(async () => {
  if (dbAvailable) await mongoose.disconnect();
});
