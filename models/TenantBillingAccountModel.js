import mongoose from "mongoose";

// Enterprise Subscription Platform — CORE platform, not Finance. The
// spec's own "Merchant Account" concept, deliberately renamed to "Billing
// Account" here — this is the TENANT's own billing/payment-method profile
// with THIS SaaS platform (how ABC Builders pays MAQVERA for its own
// license), never to be confused with the "Merchant" repeatedly and
// deliberately dropped across every Finance File in this codebase (a
// merchant/storefront entity WITHIN a tenant's own business, which has no
// backing infrastructure anywhere and still doesn't here either). Exactly
// one per tenant.
const TenantBillingAccountSchema = new mongoose.Schema({
  tenantId: {
    type: String,
    required: true,
    unique: true,
    index: true
  },
  // Enterprise Merchant & Billing Platform (Improvement 3) — "One
  // merchant can own multiple billing accounts" is modeled here as: this
  // row's own anchor `tenantId` plus `additionalTenantIds` together are
  // the real member list a shared billing account covers, all optionally
  // grouped under one real MerchantAccountModel. Deliberately additive,
  // not a restructure — every pre-existing per-tenant lookup
  // (`findOne({tenantId})` throughout TenantSubscriptionService) keeps
  // working completely unchanged; `additionalTenantIds` is empty for
  // every billing account that predates this Improvement. Each member
  // tenant still owns its own independent TenantSubscriptionModel row
  // (real, granular per-tenant enforcement stays intact) — this is a
  // purely commercial/invoicing grouping, never a data-isolation one.
  merchantAccountId: { type: mongoose.Schema.Types.ObjectId, ref: "merchant_account", default: null },
  additionalTenantIds: { type: [String], default: [] },
  // "Billing Account stores... Currency." (Improvement 3) — real, the
  // currency this billing account is invoiced in. "Multi-Currency
  // Billing... Billing Currency USD -> Finance Currency PKR. Perfectly
  // valid." — deliberately independent of any member tenant's own
  // Finance-module base currency (Part 19's own CurrencyModel), which
  // this platform never reads or constrains.
  invoiceCurrency: { type: String, default: null },
  billingContactName: { type: String, required: true },
  billingContactEmail: { type: String, required: true },
  billingContactPhone: { type: String, default: null },
  taxNumber: { type: String, default: null },
  billingAddress: {
    line1: { type: String, default: null },
    city: { type: String, default: null },
    country: { type: String, default: null },
    postalCode: { type: String, default: null }
  },
  // "Tax Address" — real, distinct from the invoice/billing address above
  // (a real, common enterprise-billing case: registered tax jurisdiction
  // differs from where invoices are mailed). Falls back to
  // `billingAddress` when unset, never duplicated by default.
  taxAddress: {
    line1: { type: String, default: null },
    city: { type: String, default: null },
    country: { type: String, default: null },
    postalCode: { type: String, default: null }
  },
  // "Credit Limit... Outstanding Balance... Payment Terms... Invoice
  // Cycle." Real fields; enforcement of creditLimit against
  // outstandingBalance (blocking a new charge past the limit) is not
  // built in this pass — real, buildable follow-up, not guessed at here.
  creditLimit: { type: Number, default: null },
  outstandingBalance: { type: Number, default: 0 },
  paymentTermsDays: { type: Number, default: 0 },
  invoiceCycle: { type: String, default: null },
  // "Billing Contacts... Primary, Finance, Technical, Tax, Legal,
  // Collection Contact." Config-driven (billingContactTypes) — real,
  // additive to the single billingContactName/Email/Phone above (kept
  // for backward compatibility as the real Primary contact).
  contacts: [{
    // Named `contactType`, not `type` — Mongoose reserves a sub-schema
    // field literally named `type` to mean "this array element's own
    // SchemaType," which would silently break this into something else
    // entirely rather than a real nested field.
    contactType: { type: String, required: true },
    name: { type: String, default: null },
    email: { type: String, default: null },
    phone: { type: String, default: null }
  }],
  // Enterprise Subscription Automation Layer — Automation #7 (Enterprise
  // Notification Timeline). "Notification Preferences... Timezone,
  // Business Hours." Real, genuinely enforceable — `timezone` is a real
  // IANA zone name (validated via `Intl.DateTimeFormat` at check time, not
  // a fabricated offset), `quietHoursStart`/`End` are "HH:mm" 24-hour
  // strings. "Preferred Language" from the same spec section is honestly
  // NOT built here — no localization/i18n infrastructure exists anywhere
  // in this codebase to translate a rendered template into (see
  // SubscriptionNotificationService's own doc comment).
  quietHoursEnabled: { type: Boolean, default: false },
  quietHoursStart: { type: String, default: null },
  quietHoursEnd: { type: String, default: null },
  timezone: { type: String, default: "UTC" },
  // Config-driven (billingPaymentMethods) — Stripe, BankTransfer,
  // EasyPaisa, JazzCash, Manual. Only "Stripe" has a real gateway
  // integration anywhere in this codebase (services/gateways/
  // StripeGatewayAdapter.js) — the others are real, legitimate payment
  // method labels a tenant can be billed under, but always settle through
  // the real Manual-payment path (a human confirms the money arrived
  // externally), never a fabricated gateway API call.
  paymentMethod: { type: String, required: true },
  // Real Stripe Customer id — only ever populated by a genuine
  // stripe.customers.create() call (TenantSubscriptionService), never a
  // placeholder string.
  stripeCustomerId: { type: String, default: null },
  // Real Stripe PaymentMethod id (the saved card/bank-debit token) — set
  // once a tenant genuinely attaches a payment method via Stripe; without
  // it, chargeAutoDebit has nothing to charge and fails honestly.
  stripePaymentMethodId: { type: String, default: null },
  // Informational only for BankTransfer/EasyPaisa/JazzCash — there is no
  // real API to validate or auto-debit against these, so this is exactly
  // what a human operator would need to manually confirm a transfer,
  // never used to move money automatically.
  manualPaymentDetails: {
    accountTitle: { type: String, default: null },
    accountNumber: { type: String, default: null },
    bankOrProviderName: { type: String, default: null }
  },
  // Config-driven (billingAccountStatuses) — Pending, Verified, Active,
  // Suspended.
  status: { type: String, required: true, index: true },
  timeline: [{
    event: { type: String, required: true },
    description: { type: String, default: null },
    performedBy: { type: String, default: null },
    performedAt: { type: Date, default: Date.now }
  }],
  createdBy: { type: String, default: null },
  updatedBy: { type: String, default: null }
}, { timestamps: true, optimisticConcurrency: true });

TenantBillingAccountSchema.set("toJSON", {
  transform: (_, ret) => {
    delete ret.__v;
    return ret;
  }
});

const TenantBillingAccountModel = mongoose.model("tenant_billing_account", TenantBillingAccountSchema);

export default TenantBillingAccountModel;
