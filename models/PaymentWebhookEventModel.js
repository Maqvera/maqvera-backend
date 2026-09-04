import mongoose from "mongoose";

// Per-Tenant Payment Gateway Integration — real, durable idempotency
// record for inbound Stripe webhook events. Deliberately SEPARATE from
// `middleware/idempotency.js` (that one is for a CLIENT retrying its own
// API request with an `Idempotency-Key` header it generated) — this one
// is for STRIPE retrying delivery of the exact same event, identified by
// Stripe's own real `event.id`. The unique index on `stripeEventId` is
// the actual enforcement mechanism: a second delivery of the same event
// hits a duplicate-key error on `create()`, never double-processed.
const PaymentWebhookEventSchema = new mongoose.Schema({
  stripeEventId: { type: String, required: true, unique: true, index: true },
  eventType: { type: String, required: true, index: true },
  // Null when the event carries no `event.account` (a platform-level
  // event, not tied to any connected account) or when no tenant's
  // `paymentGateways.accountId` matched it — a real, honest "unresolved"
  // state, never a guessed tenant.
  tenantId: { type: String, default: null, index: true },
  accountId: { type: String, default: null },
  // Processing (claimed, not yet finished) -> Processed | Ignored (no
  // tenant matched, or an event type this integration doesn't act on —
  // still real 200-acknowledged per Stripe's own requirement, genuinely a
  // no-op) | Error (a genuine processing failure — the ONLY status a
  // retried delivery of the same event.id is allowed to re-claim and
  // retry; every other terminal status permanently blocks reprocessing).
  status: { type: String, enum: ["Processing", "Processed", "Ignored", "Error"], required: true },
  errorMessage: { type: String, default: null },
  receivedAt: { type: Date, required: true, default: Date.now }
}, { timestamps: true });

PaymentWebhookEventSchema.set("toJSON", {
  transform: (_, ret) => {
    delete ret.__v;
    return ret;
  }
});

const PaymentWebhookEventModel = mongoose.model("payment_webhook_event", PaymentWebhookEventSchema);

export default PaymentWebhookEventModel;
