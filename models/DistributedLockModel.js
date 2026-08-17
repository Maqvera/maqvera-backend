import mongoose from "mongoose";

// Enterprise Subscription Automation Layer — Automation #8 (Enterprise
// Bulk Processing Engine). "Distributed Locking MUST prevent duplicate
// execution... Suppose 2 schedulers accidentally start... Without lock ->
// Processed Twice." Real, generic, Mongo-backed mutual-exclusion lock —
// deliberately NOT Redis-only, since Redis (`REDIS_URL`) is optional
// throughout this codebase (see `utils/cacheManager.js`'s own
// Redis-or-memory fallback) and a lock that silently degrades to a
// non-distributed in-memory Map when Redis is absent would be dishonest
// about actually preventing duplicate execution across instances. MongoDB
// is the one datastore every real deployment of this codebase always has,
// and a single-document `findOneAndUpdate`/unique-index race is genuinely
// atomic — see `utils/distributedLock.js` for the acquire/release logic
// this collection backs.
const DistributedLockSchema = new mongoose.Schema({
  lockKey: { type: String, required: true, unique: true },
  lockedBy: { type: String, required: true },
  acquiredAt: { type: Date, required: true },
  // TTL index below auto-reaps a stale lock row from a crashed holder that
  // never released it — the acquire logic ALSO checks `expiresAt` itself
  // (never relies on TTL cleanup timing for correctness, only for
  // eventual collection hygiene).
  expiresAt: { type: Date, required: true }
}, { timestamps: true });

DistributedLockSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

DistributedLockSchema.set("toJSON", {
  transform: (_, ret) => {
    delete ret.__v;
    return ret;
  }
});

const DistributedLockModel = mongoose.model("distributed_lock", DistributedLockSchema);

export default DistributedLockModel;
