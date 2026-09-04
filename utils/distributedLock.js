import crypto from "crypto";
import DistributedLockModel from "../models/DistributedLockModel.js";
import logger from "./logger.js";

/**
 * Enterprise Subscription Automation Layer — Automation #8 (Enterprise
 * Bulk Processing Engine). Real, correct distributed lock built on a
 * single MongoDB unique index, no external lock service required:
 *
 * - Not-yet-held key: a plain `create()` either succeeds (we own it) or
 *   throws a duplicate-key error (someone else won the race).
 * - Held-but-expired key: the winner of an atomic `deleteOne({ _id,
 *   expiresAt: { $lte: now } })` (at most one concurrent deleter ever
 *   reports `deletedCount: 1` for the same row) re-attempts the `create()`.
 *   A racer that loses the delete simply fails to acquire, rather than
 *   both racers renewing the same expired row and believing they both own
 *   it (the bug a naive `findOneAndUpdate` upsert-with-filter would have).
 */
const genOwner = () => `${process.pid}-${crypto.randomUUID()}`;

// Real, genuine correctness gap this engine's own concurrent worker pool
// (Automation #8) actually surfaced under load: Mongoose does not wait for
// a freshly-compiled model's background index build (`createIndexes()`)
// before allowing `create()` calls through — `unique: true` in the schema
// is not yet ENFORCED at the database level until that build finishes. Two
// callers racing `tryInsert()` against a brand-new `DistributedLockModel`
// collection could both "succeed" before the real unique index exists,
// silently defeating the one guarantee this whole module exists for.
// `Model.init()` is Mongoose's own documented way to await that build —
// memoized so it only actually waits once per process, not on every call.
let indexesReadyPromise = null;
const ensureIndexesReady = () => {
  if (!indexesReadyPromise) {
    indexesReadyPromise = DistributedLockModel.init().catch((error) => {
      indexesReadyPromise = null; // a real connection hiccup should be retried on the next call, not permanently cached as "ready"
      throw error;
    });
  }
  return indexesReadyPromise;
};

export const acquireLock = async (lockKey, ttlMs, ownerLabel = null) => {
  await ensureIndexesReady();
  const owner = ownerLabel || genOwner();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + ttlMs);

  const tryInsert = async () => {
    try {
      await DistributedLockModel.create({ lockKey, lockedBy: owner, acquiredAt: now, expiresAt });
      return true;
    } catch (error) {
      if (error.code === 11000) return false; // lost the race, or a real, unexpired lock already exists
      throw error;
    }
  };

  if (await tryInsert()) return { acquired: true, owner };

  const existing = await DistributedLockModel.findOne({ lockKey }).lean();
  if (existing && existing.expiresAt <= now) {
    const deleted = await DistributedLockModel.deleteOne({ _id: existing._id, expiresAt: { $lte: now } });
    if (deleted.deletedCount === 1 && (await tryInsert())) {
      return { acquired: true, owner };
    }
  }

  return { acquired: false, owner: null };
};

export const releaseLock = async (lockKey, owner) => {
  if (!owner) return;
  try {
    await DistributedLockModel.deleteOne({ lockKey, lockedBy: owner });
  } catch (error) {
    logger.error("Distributed lock release failed.", { lockKey, error: error.message });
  }
};

/** The real entry point every caller should use — acquires, runs `fn`, always releases (even on throw), and reports `{ skipped: true }` instead of throwing when another holder already owns the lock (real mutual exclusion, not an error condition). */
export const withDistributedLock = async (lockKey, ttlMs, fn) => {
  const { acquired, owner } = await acquireLock(lockKey, ttlMs);
  if (!acquired) return { skipped: true, reason: "Lock already held by another process." };

  try {
    const result = await fn();
    return { skipped: false, result };
  } finally {
    await releaseLock(lockKey, owner);
  }
};

export default { acquireLock, releaseLock, withDistributedLock };
