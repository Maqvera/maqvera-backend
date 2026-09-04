import mongoose from "mongoose";

// Enterprise Subscription Platform — CORE platform, not Finance. This
// SaaS platform's own invoice TO the tenant for their subscription fee —
// deliberately distinct from Finance's own InvoiceModel, which bills the
// TENANT'S OWN customers. Never cross-referenced with Finance's models;
// this platform owns its own billing trail end to end.
const SubscriptionInvoiceSchema = new mongoose.Schema({
  // Optional as of Improvement 3 — null on a real consolidated invoice
  // (see `tenantIds` below for the covered set); every existing
  // single-tenant invoice keeps this populated exactly as before.
  tenantId: {
    type: String,
    default: null,
    index: true
  },
  // Real, populated only on a consolidated invoice — the full set of
  // member tenants this one invoice covers (mirrors MerchantAccountModel/
  // TenantBillingAccountModel's own tenantIds convention).
  tenantIds: { type: [String], default: [] },
  invoiceNumber: {
    type: String,
    required: true,
    unique: true,
    immutable: true
  },
  // Optional as of Improvement 3 — a real CONSOLIDATED invoice (one
  // Billing Account, multiple member tenants) has no single subscription
  // to point at; `subscriptionIds` (below) carries the real set instead.
  // Every single-tenant invoice this platform already generates keeps
  // populating this field exactly as before — nothing existing changes.
  subscriptionId: { type: mongoose.Schema.Types.ObjectId, ref: "tenant_subscription", default: null, index: true },
  // Real, populated only on a consolidated invoice — every member
  // tenant's own TenantSubscriptionModel id whose current-period amount
  // this one invoice actually covers.
  subscriptionIds: { type: [mongoose.Schema.Types.ObjectId], default: [] },
  // Real FK — set only for a consolidated invoice generated against a
  // shared TenantBillingAccountModel row (Improvement 3's own "one
  // invoice, multiple companies"); null for every ordinary per-tenant invoice.
  billingAccountId: { type: mongoose.Schema.Types.ObjectId, ref: "tenant_billing_account", default: null, index: true },
  planId: { type: mongoose.Schema.Types.ObjectId, ref: "platform_plan", default: null },
  planName: { type: String, default: null },
  // Config-driven (subscriptionInvoiceTypes) — Subscription, Renewal,
  // Upgrade, Downgrade, CreditMemo, DebitMemo, TaxInvoice. Real
  // classification; real mid-cycle proration math is not built (see
  // utils/platformConfig.js's own doc comment) — every amount here is
  // still a full-period charge regardless of type.
  invoiceType: { type: String, default: "Subscription" },
  billingPeriodStart: { type: Date, required: true },
  billingPeriodEnd: { type: Date, required: true },
  amount: { type: Number, required: true, min: 0 },
  currency: { type: String, required: true },
  dueDate: { type: Date, required: true, index: true },
  // Config-driven (subscriptionInvoiceStatuses) — Draft, Sent, Paid,
  // Overdue, Void.
  status: { type: String, required: true, index: true },
  paymentMethod: { type: String, default: null },
  paidAt: { type: Date, default: null },
  // Real Stripe charge/payment-intent id — only ever populated by a
  // genuine successful Stripe API call, never fabricated.
  stripeChargeId: { type: String, default: null },
  // Real, honest failure reason from the actual attempted charge (Stripe
  // error message, or "Manual payment not yet confirmed") — never a
  // generic placeholder.
  failureReason: { type: String, default: null },
  recordedBy: { type: String, default: null },
  timeline: [{
    event: { type: String, required: true },
    description: { type: String, default: null },
    performedBy: { type: String, default: null },
    performedAt: { type: Date, default: Date.now }
  }]
}, { timestamps: true, optimisticConcurrency: true });

SubscriptionInvoiceSchema.index({ tenantId: 1, status: 1 });
SubscriptionInvoiceSchema.index({ billingAccountId: 1, status: 1 });
SubscriptionInvoiceSchema.index({ status: 1, dueDate: 1 });

SubscriptionInvoiceSchema.set("toJSON", {
  transform: (_, ret) => {
    delete ret.__v;
    return ret;
  }
});

const SubscriptionInvoiceModel = mongoose.model("subscription_invoice", SubscriptionInvoiceSchema);

export default SubscriptionInvoiceModel;
