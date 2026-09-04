import mongoose from "mongoose";

// Enterprise Subscription Platform — CORE platform, not Finance. "Tenant ≠
// Subscription — alag concepts hain." This is the real, separate
// Subscription entity the spec asks for: exactly one per tenant (unique
// index below), owning the tenant's OWN relationship with this SaaS
// platform — which plan, which billing cycle, trial/grace/suspension
// state. Distinct from Finance's own SubscriptionModel (Part 18 Part 4),
// which tracks a TENANT's *customer's* recurring billing agreement — a
// completely different real entity in a different domain, never confused
// with this one.
//
// `TenantModel.status` (models/Tenantmodel.js — active/inactive/suspended/
// deleted) remains the actual access-control switch already enforced
// throughout controllers/Auth.js and (as of this platform)
// middleware/authenticateAccessToken.js — this model is the real business
// reason WHY that switch is where it is, not a second, competing
// isolation dimension.
const TenantSubscriptionSchema = new mongoose.Schema({
  tenantId: {
    type: String,
    required: true,
    unique: true,
    index: true
  },
  planId: { type: mongoose.Schema.Types.ObjectId, ref: "platform_plan", required: true },
  // Denormalized snapshot of the plan at subscription time — a plan's own
  // tier/pricing can change later without silently altering what an
  // existing subscriber already agreed to (same "posted rate never
  // recalculated" discipline the Finance Currency platform already
  // proved for exchange rates).
  planTier: { type: String, required: true },
  planCode: { type: String, required: true },
  billingCycle: { type: String, required: true },
  amount: { type: Number, required: true, min: 0 },
  currency: { type: String, required: true },
  // Config-driven (subscriptionStatuses) — Trial, Active, PastDue,
  // GracePeriod, Suspended, Cancelled, Expired.
  status: {
    type: String,
    required: true,
    index: true
  },
  trialEndsAt: { type: Date, default: null },
  currentPeriodStart: { type: Date, required: true },
  currentPeriodEnd: { type: Date, required: true, index: true },
  // Set only once a subscription actually enters GracePeriod — real,
  // computed once from the plan's own real gracePeriodDays, never
  // recalculated after the fact (same "lock the value in" discipline as
  // a posted exchange rate).
  gracePeriodEndsAt: { type: Date, default: null },
  // Enterprise Subscription Automation Layer — Automation #4 (Enterprise
  // Grace Period Engine). `graceStartedAt` is the real "Grace Start Date"
  // the spec's own "Grace Metadata" names — distinct from
  // `currentPeriodEnd` (the billing period's own real end), since with
  // Automation #3's retry engine in place grace can genuinely start days
  // AFTER the period ended (once retries exhaust), never assumed to be
  // the same moment. Preserved (never cleared) once set, even after
  // recovery/suspension, so historical grace-duration reporting stays
  // real. `graceEndedAt` is set ONLY on a real recovery-during-grace
  // (a successful payment while still in GracePeriod) — the
  // suspension-ended case already has its own real `suspendedAt`.
  graceStartedAt: { type: Date, default: null },
  graceEndedAt: { type: Date, default: null },
  nextBillingDate: { type: Date, default: null },
  autoRenew: { type: Boolean, default: true },
  // "Renewal Flow... Notify Customer." Real, append-only log of every
  // reminder actually sent (via CommunicationPlatformService) — never a
  // guessed count.
  reminders: [{
    sentAt: { type: Date, default: Date.now },
    channel: { type: String, default: null },
    reason: { type: String, default: null } // "UpcomingRenewal" | "GracePeriod" | "PastDue"
  }],
  suspendedAt: { type: Date, default: null },
  suspendedReason: { type: String, default: null },
  reactivatedAt: { type: Date, default: null },
  // Enterprise Subscription Automation Layer — Automation #5 (Enterprise
  // Automatic Access Revocation Engine). "Blocked API Requests" — a real,
  // fire-and-forget atomic counter incremented by
  // middleware/authenticateAccessToken.js every time its own already-real
  // per-request enforcement check (`getEnforcementBlock`) actually blocks
  // a request. Never reset — a running lifetime total, same convention as
  // WebhookSubscriptionModel's own `consecutiveFailureCount`-style counters.
  blockedRequestCount: { type: Number, default: 0 },
  // "Enterprise Exception Policy... Certain contract customers may have
  // Enterprise Contract -> Never Suspend Automatically -> Create Finance
  // Case -> Manual Review." Real gate checked ONLY for AUTOMATIC
  // (scheduler-driven) suspension — a human explicitly suspending via the
  // admin API can still act on an exempt tenant on purpose. Set today only
  // via direct operator/DB action — no HTTP endpoint exposes this (see
  // TenantSubscriptionService.suspendTenant's own doc comment for why: no
  // separate "Platform Operator" identity exists anywhere in this
  // codebase's auth model to safely gate a cross-tenant action like this).
  suspensionExempt: { type: Boolean, default: false },
  suspensionExemptReason: { type: String, default: null },
  suspensionExemptSetAt: { type: Date, default: null },
  suspensionExemptSetBy: { type: String, default: null },
  // Enterprise Automatic Reactivation Workflow (Automation #9) —
  // "Exception Policy: Automatic reactivation MUST NOT happen if Fraud
  // Investigation, Chargeback, Legal Hold, Compliance Suspension, or
  // Manual Finance Review [is pending]." Same real, working precedent as
  // `suspensionExempt` above — checked at the one real chokepoint
  // (`_onPaymentReceived`) BEFORE access is restored, never after. Also
  // set today only via a direct operator/DB action or the real
  // `TenantSubscriptionService.setReactivationHold`/`resolveReactivationHold`
  // service methods — no HTTP endpoint exposes either, for the exact same
  // "no Platform Operator identity" reason `suspensionExempt` already
  // documents (resolving a hold on tenant X is inherently a cross-tenant
  // action, never something tenant X's own admin should be able to do to
  // themselves).
  reactivationHold: { type: Boolean, default: false },
  reactivationHoldType: { type: String, default: null }, // Fraud | Chargeback | LegalHold | ComplianceSuspension | ManualFinanceReview
  reactivationHoldReason: { type: String, default: null },
  reactivationHoldSetAt: { type: Date, default: null },
  reactivationHoldSetBy: { type: String, default: null },
  cancelledAt: { type: Date, default: null },
  cancelledBy: { type: String, default: null },
  cancellationReason: { type: String, default: null },
  lastPaymentAt: { type: Date, default: null },
  lastInvoiceId: { type: mongoose.Schema.Types.ObjectId, ref: "subscription_invoice", default: null },
  timeline: [{
    event: { type: String, required: true },
    description: { type: String, default: null },
    performedBy: { type: String, default: null },
    performedAt: { type: Date, default: Date.now }
  }],
  createdBy: { type: String, default: null },
  updatedBy: { type: String, default: null }
}, {
  timestamps: true,
  // "Support optimistic locking." Every TenantSubscriptionService method
  // that mutates this model follows the same findOne-then-.save() shape
  // (never findOneAndUpdate), so this is a real, working guarantee.
  optimisticConcurrency: true
});

TenantSubscriptionSchema.index({ status: 1, currentPeriodEnd: 1 });
TenantSubscriptionSchema.index({ status: 1, gracePeriodEndsAt: 1 });

TenantSubscriptionSchema.set("toJSON", {
  transform: (_, ret) => {
    delete ret.__v;
    return ret;
  }
});

const TenantSubscriptionModel = mongoose.model("tenant_subscription", TenantSubscriptionSchema);

export default TenantSubscriptionModel;
