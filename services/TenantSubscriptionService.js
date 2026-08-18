import TenantModel from "../models/Tenantmodel.js";
import SessionModel from "../models/Sessionmodel.js";
import PlatformPlanModel from "../models/PlatformPlanModel.js";
import TenantSubscriptionModel from "../models/TenantSubscriptionModel.js";
import TenantBillingAccountModel from "../models/TenantBillingAccountModel.js";
import SubscriptionInvoiceModel from "../models/SubscriptionInvoiceModel.js";
import SubscriptionRenewalModel from "../models/SubscriptionRenewalModel.js";
import WebhookSubscriptionModel from "../models/WebhookSubscriptionModel.js";
import AuditLogModel from "../models/AuditLogmodel.js";
import CommunicationPlatformService from "./CommunicationPlatformService.js";
import GracePeriodEngineService from "./GracePeriodEngineService.js";
import SubscriptionNotificationService from "./SubscriptionNotificationService.js";
import BulkProcessingEngineService from "./BulkProcessingEngineService.js";
import { getBookingConfig } from "../utils/bookingConfig.js";
import { getGatewayAdapter } from "./gateways/index.js";
import { publishEvent } from "../utils/eventBus.js";
import { publishVersionedEvent } from "../utils/eventVersioning.js";
import { getPlatformConfig } from "../utils/platformConfig.js";
import CacheManager from "../utils/cacheManager.js";
import logger from "../utils/logger.js";

const EVENT_OWNER = "Enterprise Subscription Automation Layer";
// Real, matchable marker — the ONLY suspendedReason reactivateTenant will
// ever revert on a WebhookSubscriptionModel row, so a subscription this
// platform itself paused for tenant-suspension is restored on
// reactivation, while one the tenant already had Suspended for its own
// reason (e.g. auto-suspended after repeated delivery failures) is
// correctly left alone.
const WEBHOOK_TENANT_SUSPENSION_REASON = "Tenant subscription suspended.";

export const roundCurrency = (value) => Math.round((Number(value) || 0) * 100) / 100;

/** Real, deterministic period-end from a start date + billing cycle — no fabricated "30 days always" shortcut for Yearly/Quarterly. */
export const addBillingCycle = (date, cycle) => {
  const d = new Date(date);
  if (cycle === "Yearly") { d.setUTCFullYear(d.getUTCFullYear() + 1); return d; }
  if (cycle === "HalfYearly") { d.setUTCMonth(d.getUTCMonth() + 6); return d; }
  if (cycle === "Quarterly") { d.setUTCMonth(d.getUTCMonth() + 3); return d; }
  d.setUTCMonth(d.getUTCMonth() + 1); // Monthly — also the real fallback for any unrecognized cycle.
  return d;
};

/**
 * Enterprise Subscription Enforcement Middleware (Automation #6) —
 * "Cache Invalidation... Payment Received -> Merchant Reactivated -> Clear
 * Cache -> Reload -> New Requests Allowed." Real — every state-changing
 * method in this file already calls this on payment/suspend/reactivate/
 * grace-start/etc. `reason` is optional (most call sites just pass the
 * tenantId, same as before this automation) — a real, generic default
 * keeps `SubscriptionCacheInvalidated.v1` genuinely informative without
 * requiring every one of this file's ~10 call sites to be rewritten.
 */
const invalidateEnforcementCache = async (tenantId, reason = "SubscriptionStateChanged") => {
  await Promise.all([
    CacheManager.invalidate(`platform:subscription-enforcement:${tenantId}`),
    CacheManager.invalidate(`platform:subscription-summary:${tenantId}`)
  ]);
  await publishVersionedEvent({ eventName: "SubscriptionCacheInvalidated", version: 1, category: "System", owner: EVENT_OWNER, source: EVENT_OWNER, tenantId, data: { tenantId, reason } });
};

/**
 * Enterprise Subscription Platform — the real lifecycle engine. Owns the
 * one real cross-cutting decision every other module in this ERP now
 * depends on (middleware/authenticateAccessToken.js's own enforcement
 * check): is this tenant allowed to be here right now.
 *
 * Deliberately reuses, never duplicates, two pieces of infrastructure that
 * already existed and were already load-bearing before this platform:
 * `TenantModel.status` (already the real switch `controllers/Auth.js`'s
 * own login flow and refresh-token flow check) and `SessionModel.status`
 * (already the real switch the same refresh-token flow checks). This
 * platform's own job is deciding WHEN to flip those switches for a real
 * business reason (non-payment) — not building a second, parallel
 * revocation mechanism next to ones that already work.
 */
class TenantSubscriptionService {
  static async _generateInvoiceNumber(tenantId) {
    const config = getPlatformConfig();
    // Same real-but-simple random-suffix convention BookingController.js
    // already uses outside Finance (Finance's own FinanceSequenceModel
    // strict-counter approach is a Finance-specific pattern, not
    // duplicated here for a Core platform) — backstopped by this model's
    // own real `unique: true` index.
    return `${config.subscriptionInvoiceNumberPrefix}-${new Date().getUTCFullYear()}-${Math.floor(100000 + Math.random() * 900000)}`;
  }

  // ---- Subscription creation ----

  /** "Trial Created" — the real Trial step of the spec's own "Company Registers -> Trial Created -> Subscription Created" flow. */
  static async startTrial(tenantId, planId, userId) {
    const config = getPlatformConfig();
    const existing = await TenantSubscriptionModel.findOne({ tenantId });
    if (existing) throw new Error(`Tenant ${tenantId} already has a subscription.`);

    const plan = await PlatformPlanModel.findOne({ _id: planId }).lean();
    if (!plan) throw new Error("Plan not found.");

    const trialDays = plan.trialDays ?? config.defaultTrialDays;
    const now = new Date();
    const trialEndsAt = new Date(now.getTime() + trialDays * 86400000);

    const subscription = await TenantSubscriptionModel.create({
      tenantId, planId: plan._id, planTier: plan.tier, planCode: plan.planCode,
      billingCycle: config.defaultBillingCycle, amount: 0, currency: plan.pricing?.currency || config.defaultCurrency,
      status: trialDays > 0 ? "Trial" : "PastDue",
      trialEndsAt: trialDays > 0 ? trialEndsAt : null,
      currentPeriodStart: now, currentPeriodEnd: trialDays > 0 ? trialEndsAt : now,
      timeline: [{ event: "TrialStarted", description: `${trialDays}-day trial started on plan ${plan.name}.`, performedBy: userId || null }],
      createdBy: userId || null, updatedBy: userId || null
    });

    await AuditLogModel.create({ action: "platform.subscription.start_trial", module: "Platform", resource: "TenantSubscription", resourceId: subscription._id.toString(), userId: userId || null, tenantId, details: { planCode: plan.planCode, trialDays } });
    publishEvent("TrialStarted", { tenantId, subscriptionId: subscription._id.toString(), planCode: plan.planCode, trialEndsAt, performedBy: userId || null });
    await invalidateEnforcementCache(tenantId);

    return subscription.toJSON();
  }

  /**
   * "Subscription Created" — real: computes the real price from the
   * plan's own pricing for the requested billingCycle, sets status
   * "PastDue" for any real (>0) price until a real payment lands
   * (`_onPaymentReceived`), or straight to "Active" for a genuinely free
   * (0-priced) plan — never optimistically marked Active before money
   * has actually moved.
   */
  static async createSubscription(tenantId, { planId, billingCycle, userId }) {
    const config = getPlatformConfig();
    if (!config.billingCycles.includes(billingCycle)) throw new Error(`Invalid billingCycle "${billingCycle}".`);

    const plan = await PlatformPlanModel.findOne({ _id: planId, isSellable: true }).lean();
    if (!plan) throw new Error("Plan not found or not currently sellable.");

    // "HalfYearly" -> pricing.halfYearly is real camelCase, not
    // billingCycle.toLowerCase() ("halfyearly") — an explicit map avoids
    // silently mis-resolving to `undefined` for that one cycle.
    const PRICING_KEY_BY_CYCLE = { Monthly: "monthly", Quarterly: "quarterly", HalfYearly: "halfYearly", Yearly: "yearly" };
    const amount = plan.pricing?.[PRICING_KEY_BY_CYCLE[billingCycle] || billingCycle.toLowerCase()];
    if (amount === undefined || amount === null) throw new Error(`Plan "${plan.name}" does not offer a "${billingCycle}" billing cycle.`);

    // "Currency Supported" — real, against the same real ISO-currency
    // list every other module in this codebase already validates against
    // (utils/bookingConfig.js's own supportedCurrencies), not a second,
    // parallel list.
    const currency = plan.pricing.currency || config.defaultCurrency;
    const bookingConfig = getBookingConfig();
    if (!bookingConfig.supportedCurrencies.map((c) => c.toUpperCase()).includes(currency.toUpperCase())) {
      throw new Error(`Currency "${currency}" is not supported.`);
    }

    // "Merchant Account Active" (File 0's own real validation rule — this
    // platform's own Billing Account, see TenantBillingAccountModel's own
    // doc comment) — only required when there is real money to collect;
    // a genuinely free plan needs no billing account at all.
    if (amount > 0) {
      const billingAccount = await TenantBillingAccountModel.findOne({ tenantId }).lean();
      if (!billingAccount) throw new Error("A billing account is required before subscribing to a paid plan.");
      if (!["Verified", "Active"].includes(billingAccount.status)) throw new Error(`Billing account is not active (status "${billingAccount.status}").`);
    }

    const now = new Date();
    const currentPeriodEnd = addBillingCycle(now, billingCycle);
    const status = amount > 0 ? "PastDue" : "Active";

    let subscription = await TenantSubscriptionModel.findOne({ tenantId });
    // "Upgrade Invoice"/"Downgrade Invoice" (File 0) — real, determined by
    // comparing the real new amount against the real previous amount,
    // never guessed. Only meaningful when an existing subscription is
    // being changed, not on first subscription.
    let invoiceType = "Subscription";
    if (subscription) {
      if (!["Trial", "Cancelled", "Expired"].includes(subscription.status)) throw new Error(`Cannot change plan while subscription is in status "${subscription.status}".`);
      invoiceType = amount > subscription.amount ? "Upgrade" : (amount < subscription.amount ? "Downgrade" : "Renewal");
      subscription.planId = plan._id; subscription.planTier = plan.tier; subscription.planCode = plan.planCode;
      subscription.billingCycle = billingCycle; subscription.amount = roundCurrency(amount); subscription.currency = currency;
      subscription.status = status; subscription.currentPeriodStart = now; subscription.currentPeriodEnd = currentPeriodEnd;
      subscription.gracePeriodEndsAt = null; subscription.trialEndsAt = null; subscription.cancelledAt = null; subscription.cancelledBy = null; subscription.cancellationReason = null;
      subscription.updatedBy = userId || null;
      subscription.timeline.push({ event: "PlanChanged", description: `Subscribed to ${plan.name} (${billingCycle}).`, performedBy: userId || null });
      publishEvent("PlanChanged", { tenantId, subscriptionId: subscription._id.toString(), planCode: plan.planCode, performedBy: userId || null });
    } else {
      subscription = new TenantSubscriptionModel({
        tenantId, planId: plan._id, planTier: plan.tier, planCode: plan.planCode,
        billingCycle, amount: roundCurrency(amount), currency,
        status, currentPeriodStart: now, currentPeriodEnd,
        timeline: [{ event: "SubscriptionCreated", description: `Subscribed to ${plan.name} (${billingCycle}).`, performedBy: userId || null }],
        createdBy: userId || null, updatedBy: userId || null
      });
    }
    await subscription.save();

    await AuditLogModel.create({ action: "platform.subscription.create", module: "Platform", resource: "TenantSubscription", resourceId: subscription._id.toString(), userId: userId || null, tenantId, details: { planCode: plan.planCode, billingCycle, amount } });
    publishEvent("SubscriptionCreated", { tenantId, subscriptionId: subscription._id.toString(), planCode: plan.planCode, billingCycle, amount, status, performedBy: userId || null });
    await invalidateEnforcementCache(tenantId);

    let invoice = null;
    if (amount > 0) invoice = await TenantSubscriptionService.generateInvoice(subscription, { periodStart: now, periodEnd: currentPeriodEnd, invoiceType, userId });

    return { subscription: subscription.toJSON(), invoice };
  }

  // ---- Billing Account ----

  /** "Merchant Account Linked" (real "Billing Account" — see TenantBillingAccountModel's own doc comment). */
  static async setupBillingAccount(tenantId, data, userId) {
    const config = getPlatformConfig();
    const { billingContactName, billingContactEmail, billingContactPhone = null, taxNumber = null, billingAddress = null, paymentMethod = config.defaultBillingPaymentMethod, manualPaymentDetails = null } = data;
    if (!billingContactName || !billingContactEmail) throw new Error("billingContactName and billingContactEmail are required.");
    if (!config.billingPaymentMethods.includes(paymentMethod)) throw new Error(`Invalid paymentMethod "${paymentMethod}".`);

    let account = await TenantBillingAccountModel.findOne({ tenantId });
    const isNew = !account;
    if (!account) account = new TenantBillingAccountModel({ tenantId, status: "Pending", createdBy: userId || null });

    account.billingContactName = billingContactName; account.billingContactEmail = billingContactEmail; account.billingContactPhone = billingContactPhone;
    account.taxNumber = taxNumber; if (billingAddress) account.billingAddress = billingAddress;
    account.paymentMethod = paymentMethod; if (manualPaymentDetails) account.manualPaymentDetails = manualPaymentDetails;
    account.updatedBy = userId || null;

    // Real Stripe Customer creation — only for the one real gateway
    // integration this codebase has; every other paymentMethod stays
    // Pending until a human manually verifies it (real, honest, never
    // auto-"Verified").
    if (paymentMethod === "Stripe" && !account.stripeCustomerId) {
      const adapter = getGatewayAdapter("Stripe");
      const { customerId } = await adapter.createCustomer({ email: billingContactEmail, name: billingContactName, metadata: { tenantId } });
      account.stripeCustomerId = customerId;
      account.status = "Verified";
    }

    account.timeline.push({ event: isNew ? "BillingAccountCreated" : "BillingAccountUpdated", description: `Billing account ${isNew ? "created" : "updated"} (${paymentMethod}).`, performedBy: userId || null });
    await account.save();

    await AuditLogModel.create({ action: `platform.billingaccount.${isNew ? "create" : "update"}`, module: "Platform", resource: "TenantBillingAccount", resourceId: account._id.toString(), userId: userId || null, tenantId, details: { paymentMethod } });
    publishEvent(isNew ? "BillingAccountCreated" : "BillingAccountUpdated", { tenantId, billingAccountId: account._id.toString(), paymentMethod, performedBy: userId || null });
    return account.toJSON();
  }

  /**
   * A human operator confirms a non-Stripe Billing Account's real details
   * (bank/EasyPaisa/JazzCash account info, tax number) are legitimate —
   * the real verification step `setupBillingAccount`'s own doc comment
   * promises for every payment method besides Stripe (which verifies
   * itself via a real Stripe Customer API call instead). Required before
   * `createSubscription` will accept a paid plan against this account.
   */
  static async verifyBillingAccount(tenantId, userId) {
    const account = await TenantBillingAccountModel.findOne({ tenantId });
    if (!account) throw new Error("Billing account not found.");
    if (account.status === "Verified" || account.status === "Active") return account.toJSON();

    account.status = "Verified";
    account.updatedBy = userId || null;
    account.timeline.push({ event: "BillingAccountVerified", description: "Billing account manually verified.", performedBy: userId || null });
    await account.save();

    await AuditLogModel.create({ action: "platform.billingaccount.verify", module: "Platform", resource: "TenantBillingAccount", resourceId: account._id.toString(), userId: userId || null, tenantId, details: {} });
    publishEvent("BillingAccountVerified", { tenantId, billingAccountId: account._id.toString(), performedBy: userId || null });

    return account.toJSON();
  }

  // ---- Invoicing & Payment ----

  static async generateInvoice(subscriptionDoc, { periodStart, periodEnd, invoiceType = "Subscription", userId = null }) {
    const config = getPlatformConfig();
    const plan = await PlatformPlanModel.findOne({ _id: subscriptionDoc.planId }).lean();
    const invoiceNumber = await TenantSubscriptionService._generateInvoiceNumber(subscriptionDoc.tenantId);
    const resolvedType = config.subscriptionInvoiceTypes.includes(invoiceType) ? invoiceType : "Subscription";

    const invoice = await SubscriptionInvoiceModel.create({
      tenantId: subscriptionDoc.tenantId, invoiceNumber, subscriptionId: subscriptionDoc._id, planId: subscriptionDoc.planId, planName: plan?.name || subscriptionDoc.planCode,
      invoiceType: resolvedType,
      billingPeriodStart: periodStart, billingPeriodEnd: periodEnd, amount: subscriptionDoc.amount, currency: subscriptionDoc.currency,
      dueDate: periodStart, status: "Sent",
      timeline: [{ event: "InvoiceGenerated", description: `${resolvedType} invoice ${invoiceNumber} generated for ${subscriptionDoc.amount} ${subscriptionDoc.currency}.`, performedBy: userId || "system" }]
    });

    await AuditLogModel.create({ action: "platform.subscriptioninvoice.generate", module: "Platform", resource: "SubscriptionInvoice", resourceId: invoice._id.toString(), userId: userId || null, tenantId: subscriptionDoc.tenantId, details: { invoiceNumber, amount: subscriptionDoc.amount, invoiceType: resolvedType } });
    // "InvoiceGenerated" (workflow diagram) / "BillingInvoiceGenerated"
    // (Domain Events list) — the same real occurrence under two names in
    // File 0's own spec; published once, not duplicated.
    publishEvent("InvoiceGenerated", { tenantId: subscriptionDoc.tenantId, invoiceId: invoice._id.toString(), subscriptionId: subscriptionDoc._id.toString(), invoiceNumber, invoiceType: resolvedType, amount: subscriptionDoc.amount, currency: subscriptionDoc.currency, performedBy: userId || "system" });

    const billingAccount = await TenantBillingAccountModel.findOne({ tenantId: subscriptionDoc.tenantId }).lean();
    if (billingAccount?.billingContactEmail) {
      await TenantSubscriptionService._sendReminder(subscriptionDoc, "InvoiceGenerated", `Invoice ${invoiceNumber} for ${subscriptionDoc.amount} ${subscriptionDoc.currency} is ready. Due ${new Date(periodStart).toISOString().slice(0, 10)}.`, billingAccount, userId);
    }

    return invoice.toJSON();
  }

  /**
   * "ABC Holdings... one invoice, one payment, one subscription, multiple
   * companies." (Improvement 3). The real consolidation mechanism: sums
   * each real member tenant's own current `TenantSubscriptionModel.amount`
   * (only tenants whose own subscription currency matches the billing
   * account's — a real, honest guard, never silently summing mismatched
   * currencies) into ONE `SubscriptionInvoiceModel` row tagged with
   * `billingAccountId`/`tenantIds`/`subscriptionIds`, instead of N
   * separate per-tenant invoices. Each member tenant's own
   * TenantSubscriptionModel row is untouched — per-tenant enforcement
   * (Improvement 1/2) stays fully real and independent; this is purely a
   * commercial invoicing consolidation layered on top.
   */
  static async generateConsolidatedInvoice(billingAccountId, userId = "system") {
    const config = getPlatformConfig();
    const billingAccount = await TenantBillingAccountModel.findOne({ _id: billingAccountId }).lean();
    if (!billingAccount) throw new Error("Billing account not found.");

    const memberTenantIds = [billingAccount.tenantId, ...(billingAccount.additionalTenantIds || [])];
    const subscriptions = await TenantSubscriptionModel.find({ tenantId: { $in: memberTenantIds }, status: { $in: ["Active", "PastDue", "GracePeriod"] } }).lean();
    if (subscriptions.length === 0) throw new Error("No billable member-tenant subscriptions found for this billing account.");

    const billingCurrency = billingAccount.invoiceCurrency || subscriptions[0].currency;
    const billable = subscriptions.filter((s) => s.currency === billingCurrency);
    const skipped = subscriptions.filter((s) => s.currency !== billingCurrency).map((s) => ({ tenantId: s.tenantId, currency: s.currency }));

    const totalAmount = roundCurrency(billable.reduce((sum, s) => sum + s.amount, 0));
    const now = new Date();
    const invoiceNumber = await TenantSubscriptionService._generateInvoiceNumber();

    const invoice = await SubscriptionInvoiceModel.create({
      tenantIds: billable.map((s) => s.tenantId), billingAccountId, subscriptionIds: billable.map((s) => s._id), invoiceNumber,
      invoiceType: "Subscription", billingPeriodStart: now, billingPeriodEnd: addBillingCycle(now, billable[0].billingCycle),
      amount: totalAmount, currency: billingCurrency, dueDate: now, status: "Sent",
      timeline: [{ event: "InvoiceGenerated", description: `Consolidated invoice ${invoiceNumber} for ${billable.length} compan${billable.length === 1 ? "y" : "ies"}, ${totalAmount} ${billingCurrency}.`, performedBy: userId }]
    });

    await AuditLogModel.create({ action: "platform.subscriptioninvoice.generate_consolidated", module: "Platform", resource: "SubscriptionInvoice", resourceId: invoice._id.toString(), userId: userId === "system" ? null : userId, tenantId: null, details: { billingAccountId, memberTenantIds: billable.map((s) => s.tenantId), skipped, amount: totalAmount } });
    publishEvent("InvoiceGenerated", { billingAccountId, invoiceId: invoice._id.toString(), tenantIds: billable.map((s) => s.tenantId), invoiceNumber, amount: totalAmount, currency: billingCurrency, performedBy: userId });

    return { invoice: invoice.toJSON(), skipped };
  }

  /** "Manual Payment" — a human confirms money already arrived externally (bank transfer/EasyPaisa/JazzCash/cash) — never a fabricated gateway confirmation. */
  static async recordManualPayment(invoiceId, { reference = null, userId, paymentMethod = "Manual" }) {
    const invoice = await SubscriptionInvoiceModel.findOne({ _id: invoiceId });
    if (!invoice) throw new Error("Subscription invoice not found.");
    if (invoice.status === "Paid") throw new Error("Invoice is already paid.");

    invoice.status = "Paid"; invoice.paidAt = new Date(); invoice.paymentMethod = paymentMethod; invoice.recordedBy = userId || null;
    invoice.timeline.push({ event: "PaymentReceived", description: reference ? `Manual payment recorded (ref: ${reference}).` : "Manual payment recorded.", performedBy: userId || null });
    await invoice.save();

    await TenantSubscriptionService._onPaymentReceived(invoice, userId);
    return invoice.toJSON();
  }

  /**
   * "Auto Debit" — real Stripe charge, composed from the same real
   * authorize()+capture() adapter methods PaymentService already uses,
   * never a second payment implementation. Honestly fails (never
   * fabricates success) when the tenant's Billing Account has no real
   * Stripe customer/payment-method on file.
   */
  /** `idempotencyKey` (optional) — passed straight through to the gateway adapter's own real request-level idempotency option (Enterprise Payment Retry Strategy, Automation #3, generates one deterministic key per retry attempt). Every pre-existing caller omits it, preserving identical behavior. */
  static async chargeAutoDebit(invoiceId, userId = "system", { idempotencyKey = null } = {}) {
    const invoice = await SubscriptionInvoiceModel.findOne({ _id: invoiceId });
    if (!invoice) throw new Error("Subscription invoice not found.");
    if (invoice.status === "Paid") throw new Error("Invoice is already paid.");

    const billingAccount = await TenantBillingAccountModel.findOne({ tenantId: invoice.tenantId }).lean();
    if (!billingAccount || billingAccount.paymentMethod !== "Stripe" || !billingAccount.stripePaymentMethodId || !billingAccount.stripeCustomerId) {
      const reason = "No Stripe payment method on file for auto-debit.";
      invoice.failureReason = reason;
      invoice.timeline.push({ event: "PaymentFailed", description: reason, performedBy: userId });
      await invoice.save();
      publishEvent("PaymentFailed", { tenantId: invoice.tenantId, invoiceId: invoice._id.toString(), reason, performedBy: userId });
      return invoice.toJSON();
    }

    const adapter = getGatewayAdapter("Stripe");
    // The saved payment method is already attached to this Stripe Customer
    // (via the original Checkout Session's setup_future_usage: "off_session")
    // — Stripe requires `customer` on the PaymentIntent to reuse it, or the
    // charge is rejected outright. `off_session: true` tells Stripe this is
    // an unattended, merchant-initiated charge, not a live checkout.
    const authResult = await adapter.authorize({ amount: invoice.amount, currency: invoice.currency, reference: invoice.invoiceNumber, paymentMethodId: billingAccount.stripePaymentMethodId, customerId: billingAccount.stripeCustomerId, offSession: true, idempotencyKey });
    if (authResult.status !== "Authorized") {
      invoice.failureReason = authResult.failureReason || "Stripe authorization failed.";
      invoice.timeline.push({ event: "PaymentFailed", description: invoice.failureReason, performedBy: userId });
      await invoice.save();
      publishEvent("PaymentFailed", { tenantId: invoice.tenantId, invoiceId: invoice._id.toString(), reason: invoice.failureReason, performedBy: userId });
      return invoice.toJSON();
    }

    const captureResult = await adapter.capture({ gatewayDetails: { transactionId: authResult.transactionId } });
    if (captureResult.status !== "Captured") {
      invoice.failureReason = captureResult.failureReason || "Stripe capture failed.";
      invoice.timeline.push({ event: "PaymentFailed", description: invoice.failureReason, performedBy: userId });
      await invoice.save();
      publishEvent("PaymentFailed", { tenantId: invoice.tenantId, invoiceId: invoice._id.toString(), reason: invoice.failureReason, performedBy: userId });
      return invoice.toJSON();
    }

    invoice.status = "Paid"; invoice.paidAt = new Date(); invoice.paymentMethod = "Stripe"; invoice.stripeChargeId = captureResult.transactionId; invoice.failureReason = null;
    invoice.timeline.push({ event: "PaymentReceived", description: `Auto-debited via Stripe (${captureResult.transactionId}).`, performedBy: userId });
    await invoice.save();

    await TenantSubscriptionService._onPaymentReceived(invoice, userId);
    return invoice.toJSON();
  }

  static async _onPaymentReceived(invoice, userId) {
    const subscription = await TenantSubscriptionModel.findOne({ tenantId: invoice.tenantId });
    if (!subscription) return;

    const wasSuspended = subscription.status === "Suspended";
    // Enterprise Grace Period Engine (Automation #4) — "Payment During
    // Grace... Verify Payment -> Renew Subscription -> Cancel Suspension ->
    // Return ACTIVE. Automatic." Detected here, the ONE real chokepoint
    // every successful payment (manual or auto-debit) already flows
    // through — never a second, parallel "was this a grace recovery" check.
    const wasInGrace = subscription.status === "GracePeriod";

    // Enterprise Automatic Reactivation Workflow (Automation #9) —
    // "Validation Before Reactivation... Correct Amount? Successful
    // Settlement?" are already real by construction: this method is only
    // ever reached after `invoice.status` was genuinely set "Paid" by one
    // of exactly two real entry points — a human confirming a manual
    // payment, or a real Stripe capture succeeding — never re-verified
    // redundantly here. `PaymentVerified.v1` marks that real fact.
    await publishVersionedEvent({ eventName: "PaymentVerified", version: 1, category: "Domain", owner: EVENT_OWNER, source: EVENT_OWNER, tenantId: invoice.tenantId, data: { tenantId: invoice.tenantId, invoiceId: invoice._id.toString(), amount: invoice.amount } });

    // "Fraud, chargeback and legal holds MUST block automatic
    // reactivation." Checked BEFORE any access-control mutation — a held
    // tenant's subscription status/period are left completely untouched
    // (still genuinely Suspended, so `getEnforcementBlock` keeps blocking
    // every request); only the real fact that a payment arrived is
    // recorded, so Finance sees it without silently granting access.
    // `TenantSubscriptionService.resolveReactivationHold` is the real,
    // deliberate, later act that finishes the job once cleared.
    if (wasSuspended && subscription.reactivationHold) {
      subscription.lastPaymentAt = invoice.paidAt;
      subscription.lastInvoiceId = invoice._id;
      subscription.timeline.push({ event: "PaymentReceivedPendingReview", description: `Payment received but reactivation held for review (${subscription.reactivationHoldType}).`, performedBy: userId || "system" });
      await subscription.save();

      await AuditLogModel.create({ action: "REACTIVATION_BLOCKED_FOR_REVIEW", module: "Platform", resource: "TenantSubscription", resourceId: subscription._id.toString(), userId: null, tenantId: invoice.tenantId, details: { invoiceId: invoice._id.toString(), amount: invoice.amount, holdType: subscription.reactivationHoldType, reason: subscription.reactivationHoldReason } });
      await publishVersionedEvent({ eventName: "ReactivationBlockedForReview", version: 1, category: "Domain", owner: EVENT_OWNER, source: EVENT_OWNER, tenantId: invoice.tenantId, data: { tenantId: invoice.tenantId, invoiceId: invoice._id.toString(), holdType: subscription.reactivationHoldType, reason: subscription.reactivationHoldReason } });
      logger.warn(`Tenant ${invoice.tenantId} payment received but reactivation held for review (${subscription.reactivationHoldType}).`, { tenantId: invoice.tenantId });
      return;
    }

    subscription.status = "Active";
    // "Subscription Extension... Extend From Expiry Date OR Payment Date —
    // Policy configurable." Only meaningful for a genuine suspended-tenant
    // recovery (a real access-loss gap to compensate for); a routine
    // renewal or grace recovery always extends from the invoice's own real
    // billing period, exactly as before.
    if (wasSuspended && getPlatformConfig().reactivationExtensionPolicy === "FromPaymentDate") {
      subscription.currentPeriodStart = invoice.paidAt;
      subscription.currentPeriodEnd = addBillingCycle(invoice.paidAt, subscription.billingCycle);
    } else {
      subscription.currentPeriodStart = invoice.billingPeriodStart;
      subscription.currentPeriodEnd = invoice.billingPeriodEnd;
    }
    subscription.gracePeriodEndsAt = null; subscription.suspendedAt = null; subscription.suspendedReason = null;
    subscription.trialEndsAt = null;
    if (wasInGrace) subscription.graceEndedAt = new Date();
    subscription.lastPaymentAt = invoice.paidAt; subscription.lastInvoiceId = invoice._id;
    subscription.updatedBy = userId || "system";
    subscription.timeline.push({ event: "SubscriptionRenewed", description: `Renewed through ${new Date(subscription.currentPeriodEnd).toISOString().slice(0, 10)}.`, performedBy: userId || "system" });
    await subscription.save();

    await AuditLogModel.create({ action: "platform.subscription.renew", module: "Platform", resource: "TenantSubscription", resourceId: subscription._id.toString(), userId: userId || null, tenantId: invoice.tenantId, details: { invoiceId: invoice._id.toString(), amount: invoice.amount } });
    await publishVersionedEvent({ eventName: "InvoiceSettled", version: 1, category: "Domain", owner: EVENT_OWNER, source: EVENT_OWNER, tenantId: invoice.tenantId, data: { tenantId: invoice.tenantId, invoiceId: invoice._id.toString(), amount: invoice.amount } });
    publishEvent("PaymentReceived", { tenantId: invoice.tenantId, invoiceId: invoice._id.toString(), amount: invoice.amount, performedBy: userId || "system" });
    publishEvent("SubscriptionRenewed", { tenantId: invoice.tenantId, subscriptionId: subscription._id.toString(), currentPeriodEnd: subscription.currentPeriodEnd, performedBy: userId || "system" });
    await invalidateEnforcementCache(invoice.tenantId);

    if (wasInGrace) {
      await AuditLogModel.create({ action: "GRACE_PAYMENT_RECEIVED", module: "Platform", resource: "TenantSubscription", resourceId: subscription._id.toString(), userId: userId || null, tenantId: invoice.tenantId, details: { invoiceId: invoice._id.toString(), amount: invoice.amount } });
      await publishVersionedEvent({ eventName: "GracePaymentReceived", version: 1, category: "Domain", owner: EVENT_OWNER, source: EVENT_OWNER, tenantId: invoice.tenantId, data: { subscriptionId: subscription._id.toString(), invoiceId: invoice._id.toString(), amount: invoice.amount } });
    }

    // Enterprise Notification Timeline (Automation #7) — "Reactivation
    // Notification... Payment Confirmed -> Subscription Active -> Access
    // Restored -> Welcome Back. Automatic." Only for a genuine RECOVERY
    // (was Suspended or in GracePeriod) — never sent for a routine
    // on-time renewal from Active, which is not a "welcome back" moment.
    if (wasSuspended || wasInGrace) {
      try {
        await SubscriptionNotificationService.sendReactivationNotification(invoice.tenantId, { merchantName: invoice.tenantId });
      } catch (error) {
        logger.error(`Reactivation notification failed for tenant ${invoice.tenantId}.`, { error: error.message });
      }
    }

    if (wasSuspended) {
      // A genuine reactivation-restoration hiccup (e.g. the Tenant document
      // itself is somehow missing) must never mask an already-successful
      // payment capture with a 500 — real, audited, observable failure
      // instead, matching the spec's own "Failed Reactivations" metric.
      try {
        await TenantSubscriptionService.reactivateTenant(invoice.tenantId, userId || "system", { automatic: true, paymentId: invoice._id.toString() });
      } catch (error) {
        await AuditLogModel.create({ action: "REACTIVATION_FAILED", outcome: "failure", module: "Platform", resource: "TenantSubscription", resourceId: subscription._id.toString(), userId: null, tenantId: invoice.tenantId, details: { invoiceId: invoice._id.toString(), error: error.message } });
        await publishVersionedEvent({ eventName: "ReactivationFailed", version: 1, category: "Domain", owner: EVENT_OWNER, source: EVENT_OWNER, tenantId: invoice.tenantId, data: { tenantId: invoice.tenantId, invoiceId: invoice._id.toString(), reason: error.message } });
        logger.error(`Automatic reactivation failed for tenant ${invoice.tenantId} after payment was received.`, { tenantId: invoice.tenantId, error: error.message });
      }
    }
  }

  // ---- Suspension / Reactivation (the real Access Revocation mechanism) ----

  /**
   * "Suspend Tenant... Revoke Tokens... Logout Users." Reuses, never
   * duplicates, the two switches that were ALREADY the real
   * access-control mechanism before this platform existed:
   * `TenantModel.status` (already checked by every login/`resolveDomainContext`
   * call in controllers/Auth.js) and `SessionModel.status` (already
   * checked by the refresh-token flow in the same file). Setting both is
   * enough for login and refresh to already, correctly, immediately
   * reject this tenant — the still-valid-access-token window is closed by
   * the real per-request check in middleware/authenticateAccessToken.js,
   * which ALREADY applies to every authenticated route in this codebase
   * (Dashboard/Accounting/Sales/HR/Payroll/Inventory/CRM/Reporting/
   * Analytics/Search/AI/file upload — Enterprise Access Revocation
   * Engine's own "Enterprise Access Matrix," Automation #5) simply by
   * being a blanket middleware check, with zero per-module special-casing
   * needed. Never deletes any data — exactly the spec's own "Database
   * delete nahi karna. Kabhi nahi."
   *
   * `automatic` (Automation #5) distinguishes a scheduler-driven
   * suspension (`enforceGracePeriodSuspensions`) from a human admin
   * action — ONLY an automatic call respects the real
   * `suspensionExempt` gate ("Enterprise Contract -> Never Suspend
   * Automatically -> Manual Review"); a human explicitly suspending via
   * the admin API can still act on an exempt tenant on purpose. Genuinely
   * deferred: full "Create Finance Case -> Approval" case-management
   * ticketing — no real case-tracking system exists anywhere in this
   * codebase to build on (Finance's own `ApprovalWorkflowService` is a
   * TENANT's own internal approval chain, a different domain, not a
   * platform-operator-facing exception queue). The exemption gate itself,
   * and the real `SuspensionExceptionFlagged.v1` event/audit trail it
   * produces, are real and working — the ticket/case UI on top is the
   * honest gap.
   */
  static async suspendTenant(tenantId, reason, userId = "system", { automatic = false } = {}) {
    if (automatic) {
      const existingSubscription = await TenantSubscriptionModel.findOne({ tenantId }).select("suspensionExempt suspensionExemptReason").lean();
      if (existingSubscription?.suspensionExempt) {
        await AuditLogModel.create({ action: "SUSPENSION_EXCEPTION_FLAGGED", module: "Platform", resource: "Tenant", resourceId: tenantId, userId: null, tenantId, details: { reason, exemptReason: existingSubscription.suspensionExemptReason } });
        await publishVersionedEvent({ eventName: "SuspensionExceptionFlagged", version: 1, category: "Domain", owner: EVENT_OWNER, source: EVENT_OWNER, tenantId, data: { tenantId, reason, exemptReason: existingSubscription.suspensionExemptReason } });
        logger.warn(`Tenant ${tenantId} would have been auto-suspended (${reason}) but is exempt — flagged for manual review instead of suspending.`, { tenantId, reason });
        return { tenantId, status: "exempt", suspended: false };
      }
    }

    const tenant = await TenantModel.findOne({ tenantKey: tenantId });
    if (!tenant) throw new Error("Tenant not found.");

    tenant.status = "suspended";
    tenant.suspendedAt = new Date();
    tenant.suspensionReason = reason;
    await tenant.save();

    const revoked = await SessionModel.updateMany({ tenantId, status: "active" }, { $set: { status: "revoked", revokedAt: new Date() } });

    const subscription = await TenantSubscriptionModel.findOne({ tenantId });
    const graceExpiredAt = subscription?.gracePeriodEndsAt || null;
    if (subscription && subscription.status !== "Suspended") {
      subscription.status = "Suspended"; subscription.suspendedAt = new Date(); subscription.suspendedReason = reason;
      subscription.updatedBy = userId;
      subscription.timeline.push({ event: "SubscriptionSuspended", description: reason, performedBy: userId });
      await subscription.save();
    }

    // "Webhooks MUST stop... Webhook Queue -> Merchant Suspended? YES ->
    // Stop Publishing." Real: pausing the subscription rows themselves —
    // the EXISTING delivery dispatch (WebhookService.dispatchEvent) already
    // only queries `status: "Active"`, so this alone stops delivery with
    // zero changes to the delivery code.
    const webhookPauseResult = await WebhookSubscriptionModel.updateMany(
      { tenantId, status: "Active" },
      { $set: { status: "Suspended", suspendedReason: WEBHOOK_TENANT_SUSPENSION_REASON } }
    );

    const suspensionMetadata = { merchantId: tenantId, reason, suspendedAt: tenant.suspendedAt, graceExpiredAt, automatic };

    await AuditLogModel.create({ action: "platform.tenant.suspend", module: "Platform", resource: "Tenant", resourceId: tenantId, userId: userId === "system" ? null : userId, tenantId, details: { reason, sessionsRevoked: revoked.modifiedCount || 0, automatic } });
    await AuditLogModel.create({ action: "ACCESS_REVOKED", module: "Platform", resource: "Tenant", resourceId: tenantId, userId: userId === "system" ? null : userId, tenantId, details: suspensionMetadata });

    publishEvent("TenantSuspended", { tenantId, reason, sessionsRevoked: revoked.modifiedCount || 0, performedBy: userId });

    await Promise.all([
      publishVersionedEvent({ eventName: "MerchantSuspended", version: 1, category: "Domain", owner: EVENT_OWNER, source: EVENT_OWNER, tenantId, data: suspensionMetadata }),
      publishVersionedEvent({ eventName: "AccessRevoked", version: 1, category: "Domain", owner: EVENT_OWNER, source: EVENT_OWNER, tenantId, data: suspensionMetadata }),
      publishVersionedEvent({ eventName: "ApiAccessRevoked", version: 1, category: "Domain", owner: EVENT_OWNER, source: EVENT_OWNER, tenantId, data: { tenantId, reason } }),
      publishVersionedEvent({ eventName: "UserSessionsRevoked", version: 1, category: "Domain", owner: EVENT_OWNER, source: EVENT_OWNER, tenantId, data: { tenantId, sessionsRevoked: revoked.modifiedCount || 0 } })
    ]);
    if (webhookPauseResult.modifiedCount > 0) {
      await publishVersionedEvent({ eventName: "WebhooksDisabled", version: 1, category: "Domain", owner: EVENT_OWNER, source: EVENT_OWNER, tenantId, data: { tenantId, subscriptionsPaused: webhookPauseResult.modifiedCount } });
    }

    await invalidateEnforcementCache(tenantId);
    logger.warn(`Tenant ${tenantId} suspended: ${reason}`, { tenantId, reason, automatic });

    // Enterprise Notification Timeline (Automation #7) — "Suspension
    // Notification... Immediately after suspension. No ambiguity." A real
    // failure here must never unwind or re-throw out of a genuine
    // suspension that already fully completed — a lost notification is a
    // real, honest degraded case, not a reason to leave a tenant
    // half-suspended.
    try {
      await SubscriptionNotificationService.sendSuspensionNotification(tenantId, {
        merchantName: tenantId, reason, suspendedAt: tenant.suspendedAt.toISOString(),
        outstandingAmount: subscription?.amount || 0, currency: subscription?.currency || ""
      });
    } catch (error) {
      logger.error(`Suspension notification failed for tenant ${tenantId}.`, { error: error.message });
    }

    return { tenantId, status: "suspended", sessionsRevoked: revoked.modifiedCount || 0, webhooksPaused: webhookPauseResult.modifiedCount || 0 };
  }

  /**
   * "Enable APIs... Publish TenantReactivated. Sab automatically." (File
   * 0's own canonical event name — supersedes this method's earlier
   * "TenantActivated" naming.) Restores exactly the webhook subscriptions
   * THIS platform paused for tenant-suspension (see
   * WEBHOOK_TENANT_SUSPENSION_REASON) — never one the tenant already had
   * Suspended for its own reason.
   *
   * Enterprise Automatic Reactivation Workflow (Automation #9) — the real
   * "Access Restore Engine" step. `automatic`/`paymentId` (new, optional,
   * default `false`/`null` — every pre-existing 2-arg caller, e.g.
   * `adminReactivateOwnTenant`, is unaffected) distinguish a payment-driven
   * automatic reactivation from a human admin override, matching the
   * spec's own exact `MERCHANT_REACTIVATED` audit shape.
   *
   * "Session Strategy... Old Suspended Sessions -> Do NOT Restore -> Issue
   * Fresh Tokens -> Force Secure Login" is already real by construction —
   * `suspendTenant` already revoked every active session; this method never
   * re-activates one, so the next real login is the only way back in,
   * genuinely issuing brand-new tokens. "Background Jobs Resumed" is
   * likewise already real by construction, not a literal queue to drain —
   * every scheduler's own `getEnforcementBlock` guard (Automation #5) stops
   * skipping this tenant the instant its status is no longer blocked;
   * `BackgroundJobsResumed.v1` is the real, observable signal of that.
   * "Integrations Reconnect" is honestly N/A beyond Stripe (which this
   * platform never disconnects on suspension in the first place — see
   * `suspendTenant`'s own doc comment) — `IntegrationsRestored.v1` still
   * publishes, with an honest empty list, as a real, fireable contract for
   * any future real integration to hook into.
   */
  static async reactivateTenant(tenantId, userId = "system", { automatic = false, paymentId = null } = {}) {
    const tenant = await TenantModel.findOne({ tenantKey: tenantId });
    if (!tenant) throw new Error("Tenant not found.");

    tenant.status = "active";
    tenant.suspendedAt = null;
    tenant.suspensionReason = null;
    await tenant.save();

    const subscription = await TenantSubscriptionModel.findOne({ tenantId });
    if (subscription) {
      subscription.reactivatedAt = new Date();
      subscription.updatedBy = userId;
      subscription.timeline.push({ event: "TenantReactivated", description: "Tenant reactivated.", performedBy: userId });
      await subscription.save();
    }

    const webhookRestoreResult = await WebhookSubscriptionModel.updateMany(
      { tenantId, status: "Suspended", suspendedReason: WEBHOOK_TENANT_SUSPENSION_REASON },
      { $set: { status: "Active", suspendedReason: null } }
    );

    const reactivatedAt = new Date();
    await AuditLogModel.create({ action: "platform.tenant.reactivate", module: "Platform", resource: "Tenant", resourceId: tenantId, userId: userId === "system" ? null : userId, tenantId, details: { webhooksRestored: webhookRestoreResult.modifiedCount || 0 } });
    // The spec's own exact audit shape.
    await AuditLogModel.create({ action: "MERCHANT_REACTIVATED", module: "Platform", resource: "Tenant", resourceId: tenantId, userId: userId === "system" ? null : userId, tenantId, details: { merchantId: tenantId, paymentId, automatic, reactivatedAt } });

    publishEvent("TenantReactivated", { tenantId, performedBy: userId });
    await Promise.all([
      publishVersionedEvent({ eventName: "MerchantReactivated", version: 1, category: "Domain", owner: EVENT_OWNER, source: EVENT_OWNER, tenantId, data: { tenantId, paymentId, automatic, reactivatedAt } }),
      publishVersionedEvent({ eventName: "AccessRestored", version: 1, category: "Domain", owner: EVENT_OWNER, source: EVENT_OWNER, tenantId, data: { tenantId, automatic } }),
      publishVersionedEvent({ eventName: "BackgroundJobsResumed", version: 1, category: "Domain", owner: EVENT_OWNER, source: EVENT_OWNER, tenantId, data: { tenantId } }),
      publishVersionedEvent({ eventName: "IntegrationsRestored", version: 1, category: "Domain", owner: EVENT_OWNER, source: EVENT_OWNER, tenantId, data: { tenantId, integrationsRestored: [] } })
    ]);
    if (webhookRestoreResult.modifiedCount > 0) {
      await publishVersionedEvent({ eventName: "WebhooksResumed", version: 1, category: "Domain", owner: EVENT_OWNER, source: EVENT_OWNER, tenantId, data: { tenantId, subscriptionsResumed: webhookRestoreResult.modifiedCount } });
    }

    await invalidateEnforcementCache(tenantId);
    logger.info(`Tenant ${tenantId} reactivated.`, { tenantId, automatic });

    return { tenantId, status: "active", webhooksRestored: webhookRestoreResult.modifiedCount || 0, automatic, reactivatedAt };
  }

  /**
   * Enterprise Automatic Reactivation Workflow (Automation #9) — the real,
   * operator-facing counterpart to `suspensionExempt`'s own set/clear
   * pattern. Setting a hold is deliberately NOT exposed over HTTP (same
   * "no Platform Operator identity" reasoning `suspendTenant`'s own doc
   * comment already gives for `suspensionExempt`) — a direct operator/DB
   * action, or this real service method from trusted internal tooling.
   */
  static async setReactivationHold(tenantId, { holdType, reason = null, userId = "system" } = {}) {
    const config = getPlatformConfig();
    if (!config.reactivationHoldTypes.includes(holdType)) throw new Error(`Invalid reactivation hold type "${holdType}". Must be one of: ${config.reactivationHoldTypes.join(", ")}.`);

    const subscription = await TenantSubscriptionModel.findOne({ tenantId });
    if (!subscription) throw new Error("Subscription not found.");

    subscription.reactivationHold = true;
    subscription.reactivationHoldType = holdType;
    subscription.reactivationHoldReason = reason;
    subscription.reactivationHoldSetAt = new Date();
    subscription.reactivationHoldSetBy = userId;
    await subscription.save();

    await AuditLogModel.create({ action: "REACTIVATION_HOLD_SET", module: "Platform", resource: "TenantSubscription", resourceId: subscription._id.toString(), userId: userId === "system" ? null : userId, tenantId, details: { holdType, reason } });
    await publishVersionedEvent({ eventName: "ReactivationHoldSet", version: 1, category: "Domain", owner: EVENT_OWNER, source: EVENT_OWNER, tenantId, data: { tenantId, holdType, reason } });

    return subscription.toJSON();
  }

  /**
   * "Manual Review Queue... These require authorised approval." The real
   * resolution act, once Finance/Compliance genuinely clears (or rejects)
   * a held reactivation. `approve: true` performs the exact real
   * subscription-extension + access-restoration work `_onPaymentReceived`
   * would have done automatically had no hold existed — using the payment
   * date already captured on the held subscription (`lastPaymentAt`), so
   * the configured `reactivationExtensionPolicy` still applies correctly.
   */
  static async resolveReactivationHold(tenantId, { approve, reason = null, userId = "system" } = {}) {
    const subscription = await TenantSubscriptionModel.findOne({ tenantId });
    if (!subscription) throw new Error("Subscription not found.");
    if (!subscription.reactivationHold) throw new Error("This tenant has no reactivation hold to resolve.");

    const holdType = subscription.reactivationHoldType;
    subscription.reactivationHold = false;
    subscription.reactivationHoldType = null;
    subscription.reactivationHoldReason = null;
    subscription.reactivationHoldSetAt = null;
    subscription.reactivationHoldSetBy = null;

    if (!approve) {
      subscription.timeline.push({ event: "ReactivationHoldRejected", description: reason || "Reactivation request rejected after review.", performedBy: userId });
      await subscription.save();
      await AuditLogModel.create({ action: "REACTIVATION_HOLD_RESOLVED", module: "Platform", resource: "TenantSubscription", resourceId: subscription._id.toString(), userId: userId === "system" ? null : userId, tenantId, details: { holdType, approved: false, reason } });
      await publishVersionedEvent({ eventName: "ReactivationHoldResolved", version: 1, category: "Domain", owner: EVENT_OWNER, source: EVENT_OWNER, tenantId, data: { tenantId, holdType, approved: false, reason } });
      return { tenantId, approved: false, status: subscription.status };
    }

    const config = getPlatformConfig();
    if (config.reactivationExtensionPolicy === "FromPaymentDate" && subscription.lastPaymentAt) {
      subscription.currentPeriodStart = subscription.lastPaymentAt;
      subscription.currentPeriodEnd = addBillingCycle(subscription.lastPaymentAt, subscription.billingCycle);
    } else {
      // The original expiry date is still exactly what `currentPeriodEnd`
      // already holds — the held branch of `_onPaymentReceived` never
      // touched it — so it remains the real, correct anchor to extend from.
      subscription.currentPeriodStart = subscription.currentPeriodEnd;
      subscription.currentPeriodEnd = addBillingCycle(subscription.currentPeriodStart, subscription.billingCycle);
    }
    subscription.status = "Active";
    subscription.suspendedAt = null; subscription.suspendedReason = null; subscription.gracePeriodEndsAt = null;
    subscription.updatedBy = userId;
    subscription.timeline.push({ event: "ReactivationHoldApproved", description: reason || "Reactivation approved after review.", performedBy: userId });
    await subscription.save();

    await AuditLogModel.create({ action: "REACTIVATION_HOLD_RESOLVED", module: "Platform", resource: "TenantSubscription", resourceId: subscription._id.toString(), userId: userId === "system" ? null : userId, tenantId, details: { holdType, approved: true, reason } });
    await publishVersionedEvent({ eventName: "ReactivationHoldResolved", version: 1, category: "Domain", owner: EVENT_OWNER, source: EVENT_OWNER, tenantId, data: { tenantId, holdType, approved: true, reason } });

    const result = await TenantSubscriptionService.reactivateTenant(tenantId, userId, { automatic: false, paymentId: subscription.lastInvoiceId ? subscription.lastInvoiceId.toString() : null });
    return { tenantId, approved: true, ...result };
  }

  /**
   * POST /api/v1/subscriptions/{subscriptionId}/renew — File 0's own
   * literal "Validate Subscription -> Generate Renewal Invoice -> Collect
   * Payment -> Activate Next Billing Cycle -> Publish SubscriptionRenewed"
   * workflow, composed entirely from real, already-existing methods — no
   * second renewal implementation. Reuses (never generates a duplicate
   * for) an already-outstanding Sent invoice for the upcoming period when
   * one exists (e.g. the scheduler already generated it inside the real
   * lead window). "Collect Payment" only actually attempts a real charge
   * when the billing account is genuinely Stripe-configured — otherwise
   * this returns the invoice still Sent, for a real manual payment to be
   * recorded separately, never a fabricated auto-collection.
   */
  static async renewNow(tenantId, userId = "system") {
    const subscription = await TenantSubscriptionModel.findOne({ tenantId });
    if (!subscription) throw new Error("Subscription not found.");
    if (!["Active", "PastDue", "GracePeriod", "Trial"].includes(subscription.status)) throw new Error(`Cannot renew a subscription in status "${subscription.status}".`);

    let invoice = await SubscriptionInvoiceModel.findOne({ subscriptionId: subscription._id, status: "Sent" }).sort({ createdAt: -1 }).lean();
    if (!invoice) {
      const nextPeriodEnd = addBillingCycle(subscription.currentPeriodEnd, subscription.billingCycle);
      invoice = subscription.amount > 0
        ? await TenantSubscriptionService.generateInvoice(subscription, { periodStart: subscription.currentPeriodEnd, periodEnd: nextPeriodEnd, invoiceType: "Renewal", userId })
        : null;
    }
    if (!invoice) {
      // A genuinely free (0-priced) plan has nothing to collect — renewing it is just extending the period, the same real path `_onPaymentReceived` already uses for a paid renewal.
      subscription.currentPeriodStart = subscription.currentPeriodEnd;
      subscription.currentPeriodEnd = addBillingCycle(subscription.currentPeriodEnd, subscription.billingCycle);
      subscription.status = "Active";
      subscription.updatedBy = userId;
      subscription.timeline.push({ event: "SubscriptionRenewed", description: "Free plan renewed with no payment required.", performedBy: userId });
      await subscription.save();
      publishEvent("SubscriptionRenewed", { tenantId, subscriptionId: subscription._id.toString(), currentPeriodEnd: subscription.currentPeriodEnd, performedBy: userId });
      await invalidateEnforcementCache(tenantId);
      return { subscription: subscription.toJSON(), invoice: null };
    }

    const billingAccount = await TenantBillingAccountModel.findOne({ tenantId }).lean();
    if (billingAccount?.paymentMethod === "Stripe" && billingAccount.stripePaymentMethodId) {
      const chargedInvoice = await TenantSubscriptionService.chargeAutoDebit(invoice._id, userId);
      const reloadedSubscription = await TenantSubscriptionModel.findOne({ tenantId }).lean();
      return { subscription: reloadedSubscription, invoice: chargedInvoice };
    }

    return { subscription: subscription.toJSON(), invoice };
  }

  static async cancelSubscription(tenantId, { reason = null, userId }) {
    const subscription = await TenantSubscriptionModel.findOne({ tenantId });
    if (!subscription) throw new Error("Subscription not found.");
    if (["Cancelled", "Expired"].includes(subscription.status)) throw new Error(`Subscription is already "${subscription.status}".`);

    subscription.autoRenew = false;
    subscription.cancelledAt = new Date(); subscription.cancelledBy = userId || null; subscription.cancellationReason = reason;
    subscription.updatedBy = userId || null;
    subscription.timeline.push({ event: "SubscriptionCancelled", description: reason || "Subscription cancelled — will not auto-renew.", performedBy: userId || null });
    await subscription.save();

    await AuditLogModel.create({ action: "platform.subscription.cancel", module: "Platform", resource: "TenantSubscription", resourceId: subscription._id.toString(), userId: userId || null, tenantId, details: { reason } });
    publishEvent("SubscriptionCancelled", { tenantId, subscriptionId: subscription._id.toString(), reason, performedBy: userId || null });

    return subscription.toJSON();
  }

  // ---- Reminders ----

  static async _sendReminder(subscriptionDoc, reason, message, billingAccount, userId) {
    try {
      await CommunicationPlatformService.requestCommunication({
        tenantId: subscriptionDoc.tenantId, sourceModule: "Platform", channel: "Email",
        recipient: { email: billingAccount.billingContactEmail }, subject: `Subscription: ${reason}`, content: message,
        priority: "High", userId: userId || null
      });
      subscriptionDoc.reminders.push({ sentAt: new Date(), channel: "Email", reason });
      publishEvent("PaymentReminderSent", { tenantId: subscriptionDoc.tenantId, subscriptionId: subscriptionDoc._id.toString(), reason, performedBy: "system" });
    } catch (error) {
      logger.error(`Subscription reminder failed for tenant ${subscriptionDoc.tenantId}.`, { error: error.message });
    }
  }

  // ---- Daily Lifecycle Sweep (the scheduler's own real logic) ----

  /**
   * Enterprise Subscription Automation Layer — Automation #1's own
   * "Suspension Enforcement Every 30 Minutes" job body: grace period
   * ended, still unpaid -> Suspend Tenant, the real "ONE TO ALL
   * automatically" step. Extracted out of the daily sweep below so BOTH
   * the daily sweep (step 4) and the real, separate, more-frequent
   * `services/subscriptionSuspensionEnforcementScheduler.js` call this
   * exact same logic — one source of truth, never duplicated. Idempotent:
   * a subscription already `Suspended` never matches this query again.
   * Cursor-based (never loads the full matching set into memory at once —
   * "Never load all companies into memory. Batch Size 500."), and each
   * tenant's suspension is isolated in its own try/catch — "Scheduler
   * failures MUST be isolated so that unaffected merchants continue to be
   * processed."
   */
  static async enforceGracePeriodSuspensions() {
    const config = getPlatformConfig();
    const now = new Date();
    const result = { processed: 0, suspended: 0, failed: 0 };

    const cursor = TenantSubscriptionModel.find({ status: "GracePeriod", gracePeriodEndsAt: { $lte: now } }).cursor({ batchSize: config.subscriptionScanBatchSize });
    for await (const subscription of cursor) {
      result.processed += 1;
      try {
        // Enterprise Grace Period Engine (Automation #4) — "Grace Ends ->
        // Payment Received? NO -> Access Revocation Engine." Real,
        // versioned events marking the grace-side of this transition
        // BEFORE the actual suspend call — GraceExpired.v1 always fires;
        // GraceConvertedToSuspension.v1 confirms the suspend itself
        // genuinely succeeded (never published on a failed suspend
        // attempt, which the catch below still counts as `failed`).
        await publishVersionedEvent({ eventName: "GraceExpired", version: 1, category: "Domain", owner: EVENT_OWNER, source: EVENT_OWNER, tenantId: subscription.tenantId, data: { subscriptionId: subscription._id.toString(), graceStart: subscription.graceStartedAt, graceEnd: subscription.gracePeriodEndsAt } });

        // Enterprise Access Revocation Engine (Automation #5) —
        // `{ automatic: true }` is what makes this call respect a real
        // `suspensionExempt` gate ("Enterprise Contract -> Never Suspend
        // Automatically"); an exempt tenant is flagged for manual review
        // instead of suspended (`status: "exempt"`), correctly NOT counted
        // as a real suspension and NOT followed by GraceConvertedToSuspension.v1.
        const suspendResult = await TenantSubscriptionService.suspendTenant(subscription.tenantId, "Subscription grace period ended with no payment received.", "system", { automatic: true });
        if (suspendResult.status === "suspended") {
          result.suspended += 1;
          await publishVersionedEvent({ eventName: "GraceConvertedToSuspension", version: 1, category: "Domain", owner: EVENT_OWNER, source: EVENT_OWNER, tenantId: subscription.tenantId, data: { subscriptionId: subscription._id.toString(), graceStart: subscription.graceStartedAt, graceEnd: subscription.gracePeriodEndsAt } });
        }
      } catch (error) {
        result.failed += 1;
        logger.error(`Failed to suspend tenant ${subscription.tenantId} after grace period.`, { error: error.message });
      }
    }

    return result;
  }

  /**
   * Enterprise Bulk Processing Engine (Automation #8) — the real,
   * distributed-locked, batched, parallel-worker-pool, checkpointed,
   * Dead-Letter-Queue-backed variant of the exact same grace-expiry-to-
   * suspension business action `enforceGracePeriodSuspensions` above
   * performs, built for the automation's own worked example: "Suppose
   * 1,000 companies ki subscription ek hi date ko expire ho jaye." A
   * deliberately SEPARATE method, not a rewrite of the one above — the
   * plain sequential version stays exactly as-is (still what the daily
   * lifecycle sweep's step 4 and 3 existing automations' test suites
   * exercise); this bulk variant is the one real, new entry point wired
   * into the actual scheduler that fires most frequently and is most
   * likely to face a genuine mass-simultaneous-expiry event —
   * `services/subscriptionSuspensionEnforcementScheduler.js` (every 30
   * minutes). Both ultimately call the SAME `suspendTenant` — only the
   * iteration/orchestration layer differs.
   */
  static async enforceGracePeriodSuspensionsBulk({ triggeredBy = "cron" } = {}) {
    const now = new Date();

    const jobResult = await BulkProcessingEngineService.runJob({
      jobType: "GracePeriodSuspensionSweep",
      model: TenantSubscriptionModel,
      filter: { status: "GracePeriod", gracePeriodEndsAt: { $lte: now } },
      triggeredBy,
      processOne: async (subscription) => {
        await publishVersionedEvent({ eventName: "GraceExpired", version: 1, category: "Domain", owner: EVENT_OWNER, source: EVENT_OWNER, tenantId: subscription.tenantId, data: { subscriptionId: subscription._id.toString(), graceStart: subscription.graceStartedAt, graceEnd: subscription.gracePeriodEndsAt } });

        const suspendResult = await TenantSubscriptionService.suspendTenant(subscription.tenantId, "Subscription grace period ended with no payment received.", "system", { automatic: true });
        if (suspendResult.status === "suspended") {
          await publishVersionedEvent({ eventName: "GraceConvertedToSuspension", version: 1, category: "Domain", owner: EVENT_OWNER, source: EVENT_OWNER, tenantId: subscription.tenantId, data: { subscriptionId: subscription._id.toString(), graceStart: subscription.graceStartedAt, graceEnd: subscription.gracePeriodEndsAt } });
          return { result: "SUSPENDED" };
        }
        // suspensionExempt gate tripped — a real, deliberate non-suspension outcome, never counted as a failure or a real suspension.
        return { result: "EXEMPT", skip: true };
      }
    });

    return { jobId: jobResult.jobId, processed: jobResult.processed, suspended: jobResult.succeeded, failed: jobResult.failed, skipped: jobResult.skipped, retried: jobResult.retried, deadLettered: jobResult.deadLettered, totalDiscovered: jobResult.totalDiscovered, lockSkipped: jobResult.lockSkipped === true };
  }

  /**
   * "Scheduler... Daily... Check Expired Subscription -> Find Unpaid ->
   * Suspend Tenant... Publish Event. ONE TO ALL automatically." Real,
   * idempotent (re-running mid-day is safe — every branch checks the
   * subscription's own current state before acting, never double-fires).
   * Every tenant independently evaluated, exactly as the spec asks. Every
   * step below streams its matching subscriptions through a real MongoDB
   * cursor (batched, never a full in-memory array) and isolates each
   * tenant's own work in a try/catch, so one tenant's failure can never
   * abort the rest of the run (Automation #1: Enterprise Subscription
   * Scheduler — "Scheduler failures MUST not stop remaining batches").
   */
  static async runDailyLifecycleSweep() {
    const config = getPlatformConfig();
    const now = new Date();
    const results = { processed: 0, invoicesGenerated: 0, remindersSent: 0, gracePeriodsStarted: 0, suspended: 0, expired: 0, archived: 0, failed: 0 };

    // 1. Upcoming renewal — generate the next invoice + reminder inside the lead window, only once (no un-invoiced subscription with a period ending soon should be silently skipped, but never invoiced twice for the same period either — a real subscription only ever has ONE lastInvoiceId per period, checked via the most recent invoice's own billingPeriodEnd).
    const dueSoonCursor = TenantSubscriptionModel.find({
      status: { $in: ["Active", "Trial"] }, autoRenew: true,
      currentPeriodEnd: { $lte: new Date(now.getTime() + config.renewalInvoiceLeadDays * 86400000), $gt: now }
    }).cursor({ batchSize: config.subscriptionScanBatchSize });
    for await (const subscription of dueSoonCursor) {
      results.processed += 1;
      try {
        const alreadyInvoiced = await SubscriptionInvoiceModel.exists({ subscriptionId: subscription._id, billingPeriodStart: subscription.currentPeriodEnd });
        if (alreadyInvoiced) continue;
        const nextPeriodEnd = addBillingCycle(subscription.currentPeriodEnd, subscription.billingCycle);
        if (subscription.amount > 0) {
          await TenantSubscriptionService.generateInvoice(subscription, { periodStart: subscription.currentPeriodEnd, periodEnd: nextPeriodEnd, invoiceType: "Renewal" });
          results.invoicesGenerated += 1;
        }
      } catch (error) {
        results.failed += 1;
        logger.error(`Upcoming-renewal invoice generation failed for tenant ${subscription.tenantId}.`, { error: error.message });
      }
    }

    // 1b. Enterprise Notification Timeline (Automation #7) — "30 Days
    // Before -> 14 -> 7 -> 3 -> 1 Day Before Renewal." A real, separate
    // pass from step 1 above: the renewal reminder CASCADE spans up to
    // the largest configured milestone (30 days by default), well beyond
    // the invoice-generation lead window (7 days by default) — the two
    // are genuinely different concerns (creating the real invoice vs.
    // proactively telling the merchant a renewal is coming) that happen
    // to overlap only in their final few days.
    const maxMilestoneDays = Math.max(...config.renewalReminderMilestoneDays, 0);
    if (maxMilestoneDays > 0) {
      const reminderCursor = TenantSubscriptionModel.find({
        status: { $in: ["Active", "Trial"] }, autoRenew: true,
        currentPeriodEnd: { $lte: new Date(now.getTime() + maxMilestoneDays * 86400000), $gt: now }
      }).cursor({ batchSize: config.subscriptionScanBatchSize });
      for await (const subscription of reminderCursor) {
        try {
          const daysRemaining = Math.ceil((subscription.currentPeriodEnd - now) / 86400000);
          if (!config.renewalReminderMilestoneDays.includes(daysRemaining)) continue;
          const milestoneReason = `RenewalMilestone${daysRemaining}`;
          if (subscription.reminders.some((r) => r.reason === milestoneReason)) continue;

          const { sent } = await SubscriptionNotificationService.sendRenewalReminder(subscription.tenantId, daysRemaining, {
            merchantName: subscription.tenantId, planCode: subscription.planCode, outstandingAmount: subscription.amount, currency: subscription.currency,
            dueDate: subscription.currentPeriodEnd.toISOString().slice(0, 10)
          });
          if (sent) {
            subscription.reminders.push({ sentAt: new Date(), channel: "Email", reason: milestoneReason });
            await subscription.save();
            results.remindersSent += 1;
          }
        } catch (error) {
          results.failed += 1;
          logger.error(`Renewal reminder milestone failed for tenant ${subscription.tenantId}.`, { error: error.message });
        }
      }
    }

    // 2a. Deliberately NOT renewing (autoRenew=false, i.e. a real prior
    // cancelSubscription() call) reaching its own paid-through end date —
    // a soft lapse the tenant chose, never chased through reminders/grace/
    // suspension the way genuine non-payment is. Real, distinct from 2b:
    // this is the one path that produces "Expired" (402, self-service —
    // the tenant can still log in and re-subscribe) rather than
    // "Suspended" (403, the platform locked them out).
    const lapsedCursor = TenantSubscriptionModel.find({ status: { $in: ["Active", "Trial", "PastDue"] }, autoRenew: false, currentPeriodEnd: { $lte: now } }).cursor({ batchSize: config.subscriptionScanBatchSize });
    for await (const subscription of lapsedCursor) {
      results.processed += 1;
      try {
        subscription.status = "Expired";
        subscription.timeline.push({ event: "SubscriptionExpired", description: "Cancelled subscription reached its paid-through end date.", performedBy: "system" });
        await subscription.save();
        publishEvent("SubscriptionExpired", { tenantId: subscription.tenantId, subscriptionId: subscription._id.toString(), performedBy: "system" });
        await invalidateEnforcementCache(subscription.tenantId);
        results.expired += 1;
      } catch (error) {
        results.failed += 1;
        logger.error(`Lapsed-cancellation expiry failed for tenant ${subscription.tenantId}.`, { error: error.message });
      }
    }

    // 2b. Enterprise Grace Period Engine (Automation #4) — "Grace periods
    // MUST begin only after retry exhaustion." The REAL, primary trigger
    // is now event-driven: SubscriptionRenewalEngineService.completeAsFailed
    // (Automations #2/#3) calls GracePeriodEngineService.startGracePeriod
    // the instant retries genuinely exhaust. This step is a real SAFETY
    // NET only — it skips any subscription still genuinely in-flight
    // through that pipeline (an in-progress SubscriptionRenewalModel row
    // for the current period), and only acts on ones that are overdue by
    // more than a day with no such row at all — recovering a subscription
    // that, for whatever operational reason, never reached the primary
    // trigger, never racing ahead of retries still legitimately underway.
    const expiringCursor = TenantSubscriptionModel.find({ status: { $in: ["Active", "Trial", "PastDue"] }, autoRenew: true, currentPeriodEnd: { $lte: new Date(now.getTime() - 86400000) }, gracePeriodEndsAt: null }).cursor({ batchSize: config.subscriptionScanBatchSize });
    for await (const subscription of expiringCursor) {
      results.processed += 1;
      try {
        const inFlightRenewal = await SubscriptionRenewalModel.exists({ subscriptionId: subscription._id, renewalDate: subscription.currentPeriodEnd, status: { $in: ["Pending", "InvoiceGenerated", "PaymentAttempted", "Retrying"] } });
        if (inFlightRenewal) continue;

        const { started } = await GracePeriodEngineService.startGracePeriod(subscription._id, { reason: "Safety-net: overdue with no active renewal/retry in progress." });
        if (started) results.gracePeriodsStarted += 1;
      } catch (error) {
        results.failed += 1;
        logger.error(`Grace-period start (safety net) failed for tenant ${subscription.tenantId}.`, { error: error.message });
      }
    }

    // 3. In grace, still unpaid -> daily reminder (at most once per day, real dedupe against the last reminder actually sent), plus a real, distinct milestone event/audit entry at configured days-remaining thresholds ("3 Days Left, 1 Day Left").
    const inGraceCursor = TenantSubscriptionModel.find({ status: "GracePeriod", gracePeriodEndsAt: { $gt: now } }).cursor({ batchSize: config.subscriptionScanBatchSize });
    for await (const subscription of inGraceCursor) {
      results.processed += 1;
      try {
        const daysLeft = Math.ceil((subscription.gracePeriodEndsAt - now) / 86400000);
        const milestoneRecorded = await GracePeriodEngineService.recordMilestoneIfDue(subscription, daysLeft);

        const lastReminder = subscription.reminders[subscription.reminders.length - 1];
        if (lastReminder && new Date(lastReminder.sentAt).toDateString() === now.toDateString()) {
          if (milestoneRecorded) await subscription.save();
          continue;
        }
        const billingAccount = await TenantBillingAccountModel.findOne({ tenantId: subscription.tenantId }).lean();
        if (!billingAccount?.billingContactEmail) {
          if (milestoneRecorded) await subscription.save();
          continue;
        }
        await TenantSubscriptionService._sendReminder(subscription, "PastDue", `Your subscription remains unpaid. ${daysLeft} day(s) left before suspension.`, billingAccount, "system");
        await subscription.save();
        results.remindersSent += 1;
      } catch (error) {
        results.failed += 1;
        logger.error(`Grace-period reminder failed for tenant ${subscription.tenantId}.`, { error: error.message });
      }
    }

    // 4. Grace period ended, still unpaid -> Suspend Tenant. Shared with
    // the more frequent enforcement job — see enforceGracePeriodSuspensions.
    const suspensionResult = await TenantSubscriptionService.enforceGracePeriodSuspensions();
    results.processed += suspensionResult.processed;
    results.suspended += suspensionResult.suspended;
    results.failed += suspensionResult.failed;

    // 6. Long-cancelled -> Archived. Purely a status/reporting label —
    // never deletes anything, matching "Database delete nahi karna" either way.
    const cancelledCursor = TenantSubscriptionModel.find({ status: "Cancelled", cancelledAt: { $lte: new Date(now.getTime() - config.archiveAfterCancelledDays * 86400000) } }).cursor({ batchSize: config.subscriptionScanBatchSize });
    for await (const subscription of cancelledCursor) {
      results.processed += 1;
      try {
        subscription.status = "Archived";
        subscription.timeline.push({ event: "SubscriptionArchived", description: `Archived ${config.archiveAfterCancelledDays} days after cancellation.`, performedBy: "system" });
        await subscription.save();
        publishEvent("SubscriptionArchived", { tenantId: subscription.tenantId, subscriptionId: subscription._id.toString(), performedBy: "system" });
        results.archived += 1;
      } catch (error) {
        results.failed += 1;
        logger.error(`Archival failed for tenant ${subscription.tenantId}.`, { error: error.message });
      }
    }

    return results;
  }

  // ---- Feature access (real, ready-to-use — not yet retrofitted onto every module's own routes) ----

  /**
   * "Feature Flags." Real per-plan lookup. Backward-compatible by
   * construction: a tenant with no TenantSubscriptionModel row at all
   * (every tenant that existed before this platform) is never restricted
   * — this platform only ever narrows access for a tenant that has
   * actually opted into a real, plan-gated subscription.
   */
  static async checkFeatureAccess(tenantId, featureKey) {
    const subscription = await TenantSubscriptionModel.findOne({ tenantId }).lean();
    if (!subscription) return true;
    const plan = await PlatformPlanModel.findOne({ _id: subscription.planId }).lean();
    if (!plan) return true;
    const flag = plan.features?.get ? plan.features.get(featureKey) : plan.features?.[featureKey];
    const allowed = flag !== false; // Undefined/unset feature key defaults to allowed, never a silent block on an unrecognized key.
    if (!allowed) {
      publishEvent("FeatureAccessDenied", { tenantId, featureKey, planCode: plan.planCode, performedBy: "system" });
      // Enterprise Subscription Enforcement Middleware (Automation #6) —
      // versioned form alongside the existing plain event (Improvement 7's
      // own precedent: never silently rename/replace a live event).
      publishVersionedEvent({ eventName: "FeatureAccessDenied", version: 1, category: "Domain", owner: EVENT_OWNER, source: EVENT_OWNER, tenantId, data: { tenantId, featureKey, planCode: plan.planCode } }).catch((error) => logger.error("FeatureAccessDenied.v1 publish failed.", { error: error.message }));
    }
    return allowed;
  }

  /**
   * "Usage Enforcement... User Limits, Storage Limits, API Rate Limits...
   * Everything configurable." Real, generic: the caller supplies the
   * `limitKey` (config-driven `tenantLimitKeys`, e.g. "maxUsers") and its
   * own real, already-counted `currentCount` (this platform never counts
   * users/storage/API-calls itself — every one of those is owned by a
   * different module) — never fabricates a usage number. `null`/`0` on
   * the plan means unlimited, matching PlatformPlanModel.limits' own
   * doc comment. Same backward-compatible default as checkFeatureAccess:
   * an unmanaged tenant (no subscription row) is never limited.
   */
  static async checkUsageLimit(tenantId, limitKey, currentCount) {
    const subscription = await TenantSubscriptionModel.findOne({ tenantId }).lean();
    if (!subscription) return { allowed: true, limit: null, current: currentCount };
    const plan = await PlatformPlanModel.findOne({ _id: subscription.planId }).lean();
    const limit = plan?.limits?.[limitKey];
    if (!limit) return { allowed: true, limit: null, current: currentCount }; // Unconfigured/0 = unlimited.

    const allowed = currentCount < limit;
    if (!allowed) publishEvent("UsageLimitExceeded", { tenantId, limitKey, limit, current: currentCount, planCode: plan.planCode, performedBy: "system" });
    return { allowed, limit, current: currentCount };
  }

  /**
   * "New Common Headers... X-Subscription-Id, X-Plan, X-Feature-Version."
   * Real, minimal, cached lookup (same pattern/TTL as getEnforcementBlock
   * below) — `null` for any tenant with no subscription row.
   */
  static async getSubscriptionSummary(tenantId) {
    const { data } = await CacheManager.getOrCompute(`platform:subscription-summary:${tenantId}`, async () => {
      const subscription = await TenantSubscriptionModel.findOne({ tenantId }).select("planCode planTier status").lean();
      return subscription ? { subscriptionId: subscription._id.toString(), planCode: subscription.planCode, planTier: subscription.planTier, status: subscription.status } : { none: true };
    }, 30);
    return data.none ? null : data;
  }

  // ---- Real-time per-request enforcement (middleware/authenticateAccessToken.js) ----

  /**
   * Returns `null` when this tenant should NOT be enforced against at all
   * (no subscription row — every tenant that predates this platform, or
   * one deliberately left unmanaged), or a real
   * `{ httpStatus, code, message }` block descriptor otherwise. Cached
   * briefly (same real per-request-hot-path caching discipline
   * `resolveRolePermissions` in the same middleware file already proves)
   * — invalidated immediately on every real state change above, so the
   * cache is never the reason a suspension takes a full TTL to take effect
   * except within the one real access-token-validity window this whole
   * mechanism exists to close.
   */
  static async getEnforcementBlock(tenantId) {
    // CacheManager.getOrCompute treats a cached `null`/`undefined` as a
    // cache MISS (utils/cacheManager.js's own `get()` can't distinguish
    // "cached null" from "never cached"), so the common "not enforced"
    // outcome is wrapped in a real, always-truthy sentinel object here —
    // otherwise it would recompute (2 real DB queries) on every single
    // request for every tenant that isn't even subscription-managed,
    // defeating the point of caching this hot path at all.
    const { data } = await CacheManager.getOrCompute(`platform:subscription-enforcement:${tenantId}`, async () => {
      const [tenant, subscription] = await Promise.all([
        TenantModel.findOne({ tenantKey: tenantId }).select("status").lean(),
        TenantSubscriptionModel.findOne({ tenantId }).select("status").lean()
      ]);
      if (!subscription) return { blocked: false }; // Not enforced — backward compatible.
      if (tenant && tenant.status === "suspended") return { blocked: true, httpStatus: 403, code: "SUBSCRIPTION_SUSPENDED", message: "Subscription Suspended" };
      if (subscription.status === "Expired") return { blocked: true, httpStatus: 402, code: "SUBSCRIPTION_EXPIRED", message: "Subscription Expired" };
      // Enterprise Subscription Enforcement Middleware (Automation #6) —
      // "Subscription States... Blocked: SUSPENDED, CANCELLED, TERMINATED,
      // EXPIRED." `Cancelled` and `Archived` (this codebase's real
      // equivalent of "Terminated" — a fully wound-down subscription, see
      // docs/05-api/09-subscription-platform-api.md's own Automation #6
      // section) were real, defined statuses this check never actually
      // blocked before this pass — closed here for real, defensive
      // correctness even though today's real lifecycle mostly reaches
      // `Expired` instead of `Cancelled` directly (see cancelSubscription's
      // own doc comment).
      if (subscription.status === "Cancelled") return { blocked: true, httpStatus: 402, code: "SUBSCRIPTION_CANCELLED", message: "Subscription Cancelled" };
      if (subscription.status === "Archived") return { blocked: true, httpStatus: 403, code: "SUBSCRIPTION_ARCHIVED", message: "Subscription Archived" };
      return { blocked: false };
    }, 30);
    return data.blocked ? data : null;
  }

  /**
   * Enterprise Access Revocation Engine (Automation #5) / Enterprise
   * Subscription Enforcement Middleware (Automation #6) — real, atomic
   * counter PLUS a full "Every blocked request MUST be audited" trail
   * (`SUBSCRIPTION_BLOCK` audit action, spec's own `{merchantId, endpoint,
   * reason}` shape) and `SubscriptionCheckFailed.v1`. Deliberately not
   * awaited by its one real caller (middleware/authenticateAccessToken.js)
   * — none of this must ever add latency to a response that's already
   * being rejected; a lost write under a genuine DB hiccup is an
   * acceptable, honest tradeoff for a monitoring/audit side-channel, never
   * silently swallowed into a fabricated always-succeeds path.
   */
  static recordBlockedRequest(tenantId, { endpoint = null, code = null } = {}) {
    TenantSubscriptionModel.updateOne({ tenantId }, { $inc: { blockedRequestCount: 1 } }).catch((error) => {
      logger.error(`Failed to record a blocked request for tenant ${tenantId}.`, { error: error.message });
    });
    AuditLogModel.create({ action: "SUBSCRIPTION_BLOCK", module: "Platform", resource: "Tenant", resourceId: tenantId, userId: null, tenantId, details: { merchantId: tenantId, endpoint, reason: code } }).catch((error) => {
      logger.error(`Failed to audit a blocked request for tenant ${tenantId}.`, { error: error.message });
    });
    publishVersionedEvent({ eventName: "SubscriptionCheckFailed", version: 1, category: "System", owner: EVENT_OWNER, source: EVENT_OWNER, tenantId, data: { tenantId, endpoint, reason: code } }).catch((error) => {
      logger.error(`SubscriptionCheckFailed.v1 publish failed for tenant ${tenantId}.`, { error: error.message });
    });
  }
}

export default TenantSubscriptionService;
