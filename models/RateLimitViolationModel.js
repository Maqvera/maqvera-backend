import mongoose from "mongoose";

// Enterprise Architecture Hardening Phase — API Rate Limiting & Throttling
// Standard (Improvement 13). "Monitoring — Top Consumers, Rate Limit
// Violations, Blocked Requests, Tenant Usage..." The real, queryable
// backing for that dashboard — every rejected request creates one row
// here, in addition to (not instead of) the standard `AuditLogModel`
// entry, since violations have their own real reporting shape (limit,
// count, scope) an audit log's generic `details` blob doesn't index well.
const RateLimitViolationSchema = new mongoose.Schema({
  tenantId: { type: String, default: null, index: true },
  scope: { type: String, required: true, index: true },
  ruleKey: { type: String, default: null },
  identifier: { type: String, required: true, index: true },
  limit: { type: Number, required: true },
  windowSeconds: { type: Number, required: true },
  count: { type: Number, required: true },
  requestPath: { type: String, default: null },
  correlationId: { type: String, default: null, index: true },
  occurredAt: { type: Date, required: true, default: Date.now, index: true }
}, { timestamps: true });

RateLimitViolationSchema.index({ tenantId: 1, occurredAt: -1 });
RateLimitViolationSchema.index({ scope: 1, identifier: 1, occurredAt: -1 });

RateLimitViolationSchema.set("toJSON", {
  transform: (_, ret) => {
    delete ret.__v;
    return ret;
  }
});

const RateLimitViolationModel = mongoose.model("rate_limit_violation", RateLimitViolationSchema);

export default RateLimitViolationModel;
