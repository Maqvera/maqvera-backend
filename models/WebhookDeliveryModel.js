import mongoose from "mongoose";

// "Webhook Lifecycle... Webhook Queue -> Retry Engine -> Subscriber
// Endpoint -> Acknowledgement -> Audit Log. Guaranteed delivery
// supported." Finance Module Part 18 Part 5. Immutable per-attempt
// history — a retry appends a new `attempts[]` entry, never overwrites
// the last one, the exact same "nothing is overwritten" discipline
// `PaymentModel.timeline`/`gatewayDetails` already follows. This IS the
// real Audit Log for webhook delivery, not a separate system.
const WebhookDeliveryAttemptSchema = new mongoose.Schema({
  attemptNumber: { type: Number, required: true },
  attemptedAt: { type: Date, default: Date.now },
  responseStatusCode: { type: Number, default: null },
  // Truncated — never store an unbounded third-party response body.
  responseBody: { type: String, default: null },
  succeeded: { type: Boolean, required: true },
  failureReason: { type: String, default: null }
}, { _id: false });

const WebhookDeliverySchema = new mongoose.Schema({
  tenantId: {
    type: String,
    required: true,
    index: true
  },
  webhookSubscriptionId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "webhook_subscription",
    required: true,
    index: true
  },
  // The real domain event's own id (utils/eventBus.js publishEvent) —
  // ties every delivery back to the exact DomainEventModel row it fanned
  // out from, for genuine event replay (Disaster Recovery's own "Event
  // Replay"/"Webhook Replay").
  eventId: { type: String, required: true, index: true },
  eventType: { type: String, required: true, index: true },
  payload: { type: mongoose.Schema.Types.Mixed, required: true },
  // Real HMAC-SHA256 signature actually sent on the wire, plus the
  // timestamp it was computed over — "Replay Protection... Timestamp
  // Validation" is the receiver's own job (this codebase can only ever
  // control what it sends, not what a third-party receiver enforces), so
  // both are recorded here as the honest audit trail of what was offered.
  signature: { type: String, required: true },
  signedTimestamp: { type: Number, required: true },
  // Config-driven (webhookDeliveryStatuses) — Pending, Delivered, Failed,
  // Retrying, DeadLetterQueue, Abandoned.
  status: { type: String, required: true, index: true },
  attempts: { type: [WebhookDeliveryAttemptSchema], default: [] },
  nextRetryAt: { type: Date, default: null },
  deliveredAt: { type: Date, default: null },
  // Enterprise Webhook Standard (Improvement 14). How many entries of
  // `utils/financeConfig.js#webhookLongRetryScheduleSeconds` have already
  // been consumed — the real index into "1 Minute -> 5 Minutes -> ... ->
  // 24 Hours." WebhookRetryScheduler polls for `status: "Retrying"` rows
  // whose `nextRetryAt` has passed.
  longRetryAttempt: { type: Number, default: 0 },
  // Set once this delivery genuinely exhausts the full long-horizon
  // schedule and is hand off to Improvement 6's real Dead Letter Queue —
  // the same row is then visible through the EXISTING
  // GET /api/v1/resilience/dead-letters?module=Webhook monitoring endpoint,
  // never a second, parallel DLQ list.
  dlqId: { type: mongoose.Schema.Types.ObjectId, ref: "dead_letter_queue", default: null }
}, { timestamps: true });

WebhookDeliverySchema.index({ tenantId: 1, webhookSubscriptionId: 1, createdAt: -1 });
WebhookDeliverySchema.index({ status: 1, nextRetryAt: 1 });

WebhookDeliverySchema.set("toJSON", {
  transform: (_, ret) => {
    delete ret.__v;
    return ret;
  }
});

const WebhookDeliveryModel = mongoose.model("webhook_delivery", WebhookDeliverySchema);

export default WebhookDeliveryModel;
