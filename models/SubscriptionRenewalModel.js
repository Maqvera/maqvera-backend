import mongoose from "mongoose";

// Enterprise Subscription Automation Layer — Automation #2 (Enterprise
// Automatic Renewal Engine). One real row per (subscription, renewal
// period) — the spec's own "Renewal Metadata" record. `renewalDate` is
// always the subscription's real `currentPeriodEnd` AT THE MOMENT the
// attempt started (never "today"), which is what makes the unique index
// below real, DB-enforced duplicate protection: a second scheduler pass
// for the exact same still-unrenewed period reuses this SAME row rather
// than creating a second one — "Renewal Already Processed? -> Ignore" for
// a genuinely completed period, while still allowing a fresh attempt on a
// row that previously ended in `Failed` (real retry, not a permanent block).
const SubscriptionRenewalSchema = new mongoose.Schema({
  renewalId: { type: String, required: true, unique: true },
  tenantId: { type: String, required: true, index: true },
  subscriptionId: { type: mongoose.Schema.Types.ObjectId, ref: "tenant_subscription", required: true, index: true },
  billingCycle: { type: String, required: true },
  // The real currentPeriodEnd this attempt is renewing FROM — "Extend
  // From Expiry Date, NOT Today's Date."
  renewalDate: { type: Date, required: true },
  invoiceId: { type: mongoose.Schema.Types.ObjectId, ref: "subscription_invoice", default: null },
  // Real gateway transaction id (Stripe) / "Wallet" / null until attempted.
  paymentAttemptId: { type: String, default: null },
  paymentMethod: { type: String, default: null },
  // Renewal Calculation breakdown — "Subscription Price -> Discount ->
  // Promotional Credits -> Tax -> Late Fee -> Final Amount." Every field
  // here is a real computed number, 0 where the underlying mechanism is
  // honestly not built (discount/tax — see
  // services/SubscriptionRenewalEngineService.js's own doc comment).
  subtotal: { type: Number, required: true },
  discountAmount: { type: Number, default: 0 },
  promotionalCreditApplied: { type: Number, default: 0 },
  lateFeeAmount: { type: Number, default: 0 },
  taxAmount: { type: Number, default: 0 },
  finalAmount: { type: Number, required: true },
  currency: { type: String, required: true },
  // Pending -> InvoiceGenerated -> PaymentAttempted -> (Retrying <->
  // PaymentAttempted)* -> Renewed | Failed. "Retrying" is Automation #3's
  // own real addition — a subscription sits here between a failed
  // (retryable) attempt and its next scheduled one.
  status: { type: String, required: true, enum: ["Pending", "InvoiceGenerated", "PaymentAttempted", "Retrying", "Renewed", "Failed"], default: "Pending", index: true },
  failureReason: { type: String, default: null },
  triggeredBy: { type: String, enum: ["scheduler", "manual"], default: "scheduler" },
  startedAt: { type: Date, required: true, default: Date.now },
  renewedAt: { type: Date, default: null },
  failedAt: { type: Date, default: null },
  durationMs: { type: Number, default: null },
  // Enterprise Payment Retry Strategy (Automation #3). `attemptCount`
  // includes the ORIGINAL attempt (Automation #2's own immediate charge)
  // plus every real retry since — the spec's own "Attempt #1 Immediately,
  // Attempt #2 After 24 Hours, ..." numbering, all in one place.
  // `maxAttempts` is a real snapshot of the configured limit taken at the
  // FIRST failure, so a later config change never retroactively alters an
  // already in-flight retry sequence (same "lock the value in" discipline
  // as a posted exchange rate). `nextRetryAt` is the real cron-sweep
  // anchor — the same honest, non-blocking long-horizon pattern
  // WebhookDeliveryModel already proved for Improvement 14.
  attemptCount: { type: Number, default: 0 },
  maxAttempts: { type: Number, default: null },
  nextRetryAt: { type: Date, default: null },
  attempts: [{
    attemptNumber: { type: Number, required: true },
    attemptedAt: { type: Date, default: Date.now },
    paymentMethod: { type: String, default: null },
    status: { type: String, enum: ["Succeeded", "Failed"], required: true },
    failureReason: { type: String, default: null },
    // "Temporary? -> Retry. Permanent? -> NO RETRY." Real classification
    // result for this specific attempt (utils/paymentRetryClassifier.js).
    classification: { type: String, enum: ["Retryable", "NonRetryable", null], default: null },
    paymentAttemptId: { type: String, default: null },
    idempotencyKey: { type: String, default: null }
  }],
  timeline: [{
    event: { type: String, required: true },
    description: { type: String, default: null },
    performedAt: { type: Date, default: Date.now }
  }]
}, { timestamps: true, optimisticConcurrency: true });

SubscriptionRenewalSchema.index({ subscriptionId: 1, renewalDate: 1 }, { unique: true });
SubscriptionRenewalSchema.index({ tenantId: 1, status: 1 });
SubscriptionRenewalSchema.index({ status: 1, renewedAt: -1 });
SubscriptionRenewalSchema.index({ status: 1, nextRetryAt: 1 });

SubscriptionRenewalSchema.set("toJSON", {
  transform: (_, ret) => {
    delete ret.__v;
    return ret;
  }
});

const SubscriptionRenewalModel = mongoose.model("subscription_renewal", SubscriptionRenewalSchema);

export default SubscriptionRenewalModel;
