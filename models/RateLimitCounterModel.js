import mongoose from "mongoose";

// Enterprise Architecture Hardening Phase — API Rate Limiting & Throttling
// Standard (Improvement 13). "Distributed Rate Limiting — Multiple API
// servers... Shared Rate Limit Store... All servers enforce the same
// counters." MongoDB (not an optional, not-configured-in-this-environment
// Redis) is already the one real store every API node in this codebase
// shares — the same real, proven atomic-counter pattern already used for
// `FinanceSequenceModel`/`ResourceSequenceModel` (`findOneAndUpdate($inc)`,
// atomic even on a standalone MongoDB), reused here as the genuinely
// distributed rate-limit store. A fixed window (not sliding) — `expiresAt`
// is set once, on insert, and never pushed back by later increments,
// so the TTL index reliably reclaims the bucket at the real window boundary.
const RateLimitCounterSchema = new mongoose.Schema({
  // e.g. "Tenant:tenant-abc:2027-06-01T10" — scope + identifier + window
  // bucket, already fully composed by the caller (utils/rateLimiter.js).
  bucketKey: { type: String, required: true, unique: true },
  count: { type: Number, required: true, default: 0 },
  windowStart: { type: Date, required: true },
  expiresAt: { type: Date, required: true }
}, { timestamps: true });

RateLimitCounterSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

RateLimitCounterSchema.statics.incrementAndGet = async function (bucketKey, windowStart, expiresAt) {
  const doc = await this.findOneAndUpdate(
    { bucketKey },
    { $inc: { count: 1 }, $setOnInsert: { windowStart, expiresAt } },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
  return doc;
};

const RateLimitCounterModel = mongoose.model("rate_limit_counter", RateLimitCounterSchema);

export default RateLimitCounterModel;
