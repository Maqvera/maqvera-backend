import mongoose from "mongoose";

// Enterprise Customer Payments — Finance Module Part 18 Part 5 (Enterprise
// Production Readiness). "Webhook Platform... Payment Authorized,
// Payment Captured, ... Custom Events. Everything configurable." A
// subscription's `subscribedEvents` accepts ANY event name (including
// ones never enumerated in `utils/financeConfig.js`'s own catalog) —
// "Custom Events" is real, not a fixed list, backed by
// `utils/eventBus.js`'s new `subscribeAllEvents` wildcard listener rather
// than resubscribing to a known set one at a time.
//
// `secret` is the real HMAC-SHA256 signing key (`crypto.randomBytes(32)`)
// — returned in plaintext ONLY on creation/rotation, the same
// show-once-then-mask convention every real webhook platform (Stripe,
// GitHub) uses; there is no field-level encryption-at-rest anywhere in
// this codebase (same honestly-documented gap as every other Part), so
// this is consistent with, not worse than, how every other credential in
// this codebase is stored. Tenant-scoped only — no branchId.
const WebhookSubscriptionSchema = new mongoose.Schema({
  tenantId: {
    type: String,
    required: true,
    index: true
  },
  url: {
    type: String,
    required: true
  },
  description: { type: String, default: null },
  secret: {
    type: String,
    required: true
  },
  // Any string is accepted — "Custom Events" — validated only against the
  // catalog when the caller supplies a recognized one; a genuinely custom
  // name a tenant's own integration publishes is never rejected.
  subscribedEvents: {
    type: [String],
    validate: { validator: (arr) => Array.isArray(arr) && arr.length > 0, message: "At least one subscribed event (or \"*\" for all) is required." }
  },
  // Config-driven (webhookSubscriptionStatuses) — Active, Suspended,
  // Disabled.
  status: { type: String, required: true, index: true },
  // Real circuit breaker — auto-suspends after
  // `webhookAutoSuspendFailureThreshold` CONSECUTIVE failures (Disaster
  // Recovery's own "Automatic Failover" has no real meaning for an
  // outbound HTTP call to a third party; this is the honest equivalent:
  // stop hammering a dead endpoint). Reset to 0 on any successful delivery.
  consecutiveFailureCount: { type: Number, default: 0 },
  lastDeliveryAt: { type: Date, default: null },
  lastFailureAt: { type: Date, default: null },
  suspendedReason: { type: String, default: null },
  timeline: [{
    event: { type: String, required: true },
    description: { type: String, default: null },
    performedBy: { type: String, default: null },
    performedAt: { type: Date, default: Date.now }
  }],
  createdBy: { type: String, default: null }
}, { timestamps: true });

WebhookSubscriptionSchema.index({ tenantId: 1, status: 1 });

WebhookSubscriptionSchema.set("toJSON", {
  transform: (_, ret) => {
    delete ret.__v;
    delete ret.secret; // never serialized by default — see WebhookService's own explicit opt-in for creation/rotation responses.
    return ret;
  }
});

const WebhookSubscriptionModel = mongoose.model("webhook_subscription", WebhookSubscriptionSchema);

export default WebhookSubscriptionModel;
