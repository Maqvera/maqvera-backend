import mongoose from "mongoose";

// Enterprise Customer Payments — Finance Module Part 18 Part 4 (Enterprise
// Collection Features). "Subscription Billing Support... Membership
// Billing." One real model covers both — the spec's own two lifecycle
// diagrams (Subscription Active -> Billing Cycle -> Invoice -> Payment
// Intent -> Paid -> Extended; Membership Created -> Activated -> Renewal
// Invoice -> Paid -> Extended -> Renewal Confirmation) are structurally
// identical, so `planType` distinguishes them rather than building two
// near-duplicate platforms. Every real billing cycle produces a real
// `CustomerCollectionModel` row (Part 18) with `collectionSource`
// "Subscription Invoice"/"Membership Renewal" (Part 2) — this model never
// tracks money itself, only the recurring agreement and cadence, the same
// "Collection Platform orchestrates, Payment Engine executes" split every
// other Part 18 sub-feature already follows.
// Tenant-scoped only — no branchId.
const SubscriptionPlanChangeSchema = new mongoose.Schema({
  type: { type: String, enum: ["Upgrade", "Downgrade"], required: true },
  fromAmount: { type: Number, required: true },
  toAmount: { type: Number, required: true },
  prorationAmount: { type: Number, default: 0 },
  changedAt: { type: Date, default: Date.now },
  changedBy: { type: String, default: null }
}, { _id: false });

const SubscriptionSchema = new mongoose.Schema({
  tenantId: {
    type: String,
    required: true,
    index: true
  },
  subscriptionNumber: {
    type: String,
    required: true,
    immutable: true
  },
  customerId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "customer",
    required: true,
    index: true
  },
  customerName: { type: String, required: true },
  // Config-driven (subscriptionPlanTypes) — Subscription | Membership.
  planType: { type: String, required: true, index: true },
  // No Product/Catalog model exists in this codebase (same treatment
  // InvoiceModel's own `productCode` already gives a missing catalog) —
  // a plain, opaque plan name.
  planName: { type: String, required: true },
  // Config-driven (membershipTiers) — only meaningful when planType is
  // "Membership"; null for a plain Subscription.
  membershipTier: { type: String, default: null },
  // Config-driven (subscriptionBillingCycles).
  billingCycle: { type: String, required: true },
  amount: { type: Number, required: true, min: 0.01 },
  currency: { type: String, required: true },
  // Config-driven (subscriptionStatuses) — Trial, Active, PastDue,
  // Suspended, Cancelled, Terminated.
  status: { type: String, required: true, index: true },
  currentPeriodStart: { type: Date, required: true },
  currentPeriodEnd: { type: Date, required: true },
  nextBillingDate: { type: Date, required: true, index: true },
  trialEndsAt: { type: Date, default: null },
  // Set on the first failed billing attempt of a period; cleared on the
  // next successful renewal. Past this date with no successful payment,
  // the subscription is suspended.
  graceEndsAt: { type: Date, default: null },
  retryCount: { type: Number, default: 0 },
  renewalPolicy: {
    autoRenew: { type: Boolean, default: true },
    gracePeriodDays: { type: Number, default: null },
    retryAttempts: { type: Number, default: null },
    prorationEnabled: { type: Boolean, default: true }
  },
  // "Usage-Based Billing, Metered Billing, Hybrid Billing." Real quantity
  // x unit price used to compute the next invoice amount when
  // `billingCycle` is UsageBased/Metered/Hybrid — no fabricated metering
  // pipeline, the caller reports real usage via `recordUsage` between
  // cycles.
  usage: {
    meteredQuantity: { type: Number, default: 0 },
    meteredUnitPrice: { type: Number, default: 0 }
  },
  paymentMethod: { type: String, default: null },
  paymentProvider: { type: String, default: null },
  lastCollectionId: { type: mongoose.Schema.Types.ObjectId, ref: "customer_collection", default: null },
  lastPaymentId: { type: mongoose.Schema.Types.ObjectId, ref: "payment", default: null },
  planChangeHistory: { type: [SubscriptionPlanChangeSchema], default: [] },
  pausedAt: { type: Date, default: null },
  pausedBy: { type: String, default: null },
  cancelledAt: { type: Date, default: null },
  cancelledBy: { type: String, default: null },
  cancellationReason: { type: String, default: null },
  timeline: [{
    event: { type: String, required: true },
    description: { type: String, default: null },
    performedBy: { type: String, default: null },
    performedAt: { type: Date, default: Date.now }
  }],
  createdBy: { type: String, default: null },
  updatedBy: { type: String, default: null }
}, { timestamps: true });

SubscriptionSchema.index({ tenantId: 1, subscriptionNumber: 1 }, { unique: true });
SubscriptionSchema.index({ tenantId: 1, customerId: 1, status: 1 });
SubscriptionSchema.index({ status: 1, nextBillingDate: 1 });

SubscriptionSchema.set("toJSON", {
  transform: (_, ret) => {
    delete ret.__v;
    return ret;
  }
});

const SubscriptionModel = mongoose.model("subscription", SubscriptionSchema);

export default SubscriptionModel;
