import crypto from "crypto";
import TenantSubscriptionModel from "../models/TenantSubscriptionModel.js";
import TenantBillingAccountModel from "../models/TenantBillingAccountModel.js";
import SubscriptionInvoiceModel from "../models/SubscriptionInvoiceModel.js";
import SubscriptionRenewalModel from "../models/SubscriptionRenewalModel.js";
import AuditLogModel from "../models/AuditLogmodel.js";
import TenantSubscriptionService, { roundCurrency, addBillingCycle } from "./TenantSubscriptionService.js";
import MerchantAccountService from "./MerchantAccountService.js";
import PaymentRetryEngineService from "./PaymentRetryEngineService.js";
import GracePeriodEngineService from "./GracePeriodEngineService.js";
import { publishVersionedEvent } from "../utils/eventVersioning.js";
import { getPlatformConfig } from "../utils/platformConfig.js";
import logger from "../utils/logger.js";

const EVENT_OWNER = "Enterprise Subscription Automation Layer";

/**
 * Enterprise Subscription Automation Layer — Automation #2 (Enterprise
 * Automatic Renewal Engine). "Jab subscription renewal date aa jaye to
 * system automatically payment collect kare." A real orchestrator on top
 * of infrastructure that already existed and was already tested
 * (`TenantSubscriptionService.generateInvoice`/`chargeAutoDebit`/
 * `recordManualPayment`, which already extends the subscription's period
 * FROM its own real `currentPeriodEnd` — "Early Renewal... Extend From
 * Expiry Date, NOT Today's Date" was already correct before this
 * automation existed) — this service's own new job is deciding WHEN to
 * call those, automatically, with real idempotency, a real amount
 * breakdown, and a real audit/event trail.
 */
class SubscriptionRenewalEngineService {
  /**
   * "Renewal Calculation: Subscription Price -> Discount -> Promotional
   * Credits -> Tax -> Late Fee -> Final Amount." `discountAmount` and
   * `taxAmount` are honestly always 0 — no coupon/discount-code mechanism
   * exists at this platform-billing layer (Finance's own `CouponModel`
   * bills a TENANT's OWN customers, a different domain, never reused
   * here), and no real tax-jurisdiction engine exists for platform billing
   * either (reusing Finance's `TaxService` would violate
   * `SubscriptionInvoiceModel`'s own documented "never cross-referenced
   * with Finance's models" boundary). `promotionalCreditApplied` is real —
   * a genuine `MerchantWalletModel` balance, only when this billing
   * account is actually linked to a real `MerchantAccountModel`
   * (Improvement 3; most tenants today have no such link, and correctly
   * get 0 here, not a fabricated credit).
   */
  static async _computeRenewalAmount(subscription, billingAccount) {
    const config = getPlatformConfig();
    const subtotal = roundCurrency(subscription.amount);
    let promotionalCreditApplied = 0;

    if (billingAccount?.merchantAccountId) {
      try {
        const wallet = await MerchantAccountService.getWallet(billingAccount.merchantAccountId);
        const available = roundCurrency(wallet?.balances?.promotional || 0);
        if (available > 0) promotionalCreditApplied = Math.min(available, subtotal);
      } catch (error) {
        logger.warn(`Renewal wallet-credit lookup failed for tenant ${subscription.tenantId}.`, { error: error.message });
      }
    }

    // "Late Fee (Optional)" — only when this subscription genuinely had a
    // prior renewal attempt fail, or a prior invoice go Overdue. Never
    // applied speculatively to a subscription with a clean payment history.
    const [hadPriorFailedRenewal, hadOverdueInvoice] = await Promise.all([
      SubscriptionRenewalModel.exists({ subscriptionId: subscription._id, status: "Failed", renewalDate: { $lt: subscription.currentPeriodEnd } }),
      SubscriptionInvoiceModel.exists({ subscriptionId: subscription._id, status: "Overdue" })
    ]);
    const lateFeeAmount = (hadPriorFailedRenewal || hadOverdueInvoice)
      ? roundCurrency(config.lateFeeFlatAmount + subtotal * (config.lateFeePercentOfSubtotal / 100))
      : 0;

    const discountAmount = 0;
    const taxAmount = 0;
    const finalAmount = Math.max(0, roundCurrency(subtotal - discountAmount - promotionalCreditApplied + taxAmount + lateFeeAmount));

    return { subtotal, discountAmount, promotionalCreditApplied, taxAmount, lateFeeAmount, finalAmount };
  }

  /** Public — also called by services/PaymentRetryEngineService.js (Automation #3) when a retry attempt succeeds. */
  static async completeAsRenewed(renewal, { invoiceId, paymentAttemptId, paymentMethod, subscriptionId, startTime }) {
    renewal.status = "Renewed";
    if (invoiceId) renewal.invoiceId = invoiceId;
    renewal.paymentAttemptId = paymentAttemptId;
    renewal.paymentMethod = paymentMethod;
    renewal.renewedAt = new Date();
    renewal.durationMs = Date.now() - startTime;
    renewal.timeline.push({ event: "SubscriptionRenewed", description: `Renewed via ${paymentMethod || "no charge required"}.` });
    await renewal.save();

    const reloadedSubscription = await TenantSubscriptionModel.findOne({ _id: subscriptionId }).lean();

    await AuditLogModel.create({ action: "SUBSCRIPTION_RENEWAL", module: "Platform", resource: "SubscriptionRenewal", resourceId: renewal.renewalId, userId: null, tenantId: renewal.tenantId, details: { invoiceId: renewal.invoiceId ? renewal.invoiceId.toString() : null, paymentStatus: "SUCCESS", renewedUntil: reloadedSubscription?.currentPeriodEnd || null } });
    await publishVersionedEvent({ eventName: "SubscriptionRenewed", version: 1, category: "Domain", owner: EVENT_OWNER, source: EVENT_OWNER, tenantId: renewal.tenantId, data: { renewalId: renewal.renewalId, subscriptionId: renewal.subscriptionId.toString(), renewedUntil: reloadedSubscription?.currentPeriodEnd || null, amount: renewal.finalAmount, currency: renewal.currency } });

    return { renewal: renewal.toJSON(), duplicate: false };
  }

  /**
   * Public — the real TERMINAL failure completion (retries exhausted or
   * classified non-retryable). Called by `PaymentRetryEngineService`
   * (Automation #3) once it has decided no further retry is appropriate —
   * never called directly for a failure that's still eligible for a retry.
   */
  static async completeAsFailed(renewal, failureReason, startTime) {
    renewal.status = "Failed";
    renewal.failureReason = failureReason;
    renewal.failedAt = new Date();
    renewal.durationMs = Date.now() - startTime;
    renewal.timeline.push({ event: "RenewalFailed", description: failureReason });
    await renewal.save();

    await AuditLogModel.create({ action: "SUBSCRIPTION_RENEWAL", module: "Platform", resource: "SubscriptionRenewal", resourceId: renewal.renewalId, userId: null, tenantId: renewal.tenantId, details: { invoiceId: renewal.invoiceId ? renewal.invoiceId.toString() : null, paymentStatus: "FAILED", reason: failureReason } });
    await publishVersionedEvent({ eventName: "RenewalPaymentFailed", version: 1, category: "Domain", owner: EVENT_OWNER, source: EVENT_OWNER, tenantId: renewal.tenantId, data: { renewalId: renewal.renewalId, subscriptionId: renewal.subscriptionId.toString(), reason: failureReason } });

    // Enterprise Grace Period Engine (Automation #4) — "Grace periods MUST
    // begin only after retry exhaustion." This IS that real, immediate,
    // event-driven trigger — not a wait for the next daily sweep. Real,
    // idempotent (startGracePeriod itself no-ops if the subscription isn't
    // in an eligible status, e.g. it was manually suspended in the
    // meantime), and safe to call even for the very first (non-retryable)
    // failure, since PaymentRetryEngineService.handleFailure already
    // decided retries don't apply here.
    try {
      await GracePeriodEngineService.startGracePeriod(renewal.subscriptionId, { reason: failureReason });
    } catch (error) {
      logger.error(`Grace-period start failed for subscription ${renewal.subscriptionId} after renewal exhaustion.`, { error: error.message });
    }

    return { renewal: renewal.toJSON(), duplicate: false };
  }

  /**
   * The engine's own core unit of work — one subscription, one renewal
   * period. Real, DB-enforced idempotency via `SubscriptionRenewalModel`'s
   * unique `(subscriptionId, renewalDate)` index: a second call for the
   * exact same still-`Renewed` period is a genuine no-op ("Renewal Already
   * Processed? -> Ignore"); a second call after a prior `Failed` attempt
   * reuses the SAME row and genuinely retries, rather than being
   * permanently blocked.
   */
  static async processRenewal(subscriptionId, { triggeredBy = "scheduler" } = {}) {
    const subscription = await TenantSubscriptionModel.findOne({ _id: subscriptionId });
    if (!subscription) throw new Error("Subscription not found.");

    const renewalDate = subscription.currentPeriodEnd;

    const renewal = await SubscriptionRenewalModel.findOneAndUpdate(
      { subscriptionId: subscription._id, renewalDate },
      { $setOnInsert: {
        renewalId: crypto.randomUUID(), tenantId: subscription.tenantId, subscriptionId: subscription._id,
        billingCycle: subscription.billingCycle, renewalDate, subtotal: roundCurrency(subscription.amount),
        finalAmount: roundCurrency(subscription.amount), currency: subscription.currency, status: "Pending",
        triggeredBy, startedAt: new Date()
      } },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    if (renewal.status === "Renewed") {
      return { renewal: renewal.toJSON(), duplicate: true };
    }

    const startTime = renewal.startedAt.getTime();
    await publishVersionedEvent({ eventName: "RenewalStarted", version: 1, category: "Domain", owner: EVENT_OWNER, source: EVENT_OWNER, tenantId: subscription.tenantId, data: { renewalId: renewal.renewalId, subscriptionId: subscription._id.toString(), renewalDate } });

    try {
      const billingAccount = await TenantBillingAccountModel.findOne({ tenantId: subscription.tenantId }).lean();

      // Free plan — nothing to charge, extend directly (mirrors
      // TenantSubscriptionService.renewNow's own already-real free-plan path).
      if (subscription.amount <= 0) {
        const nextPeriodEnd = addBillingCycle(subscription.currentPeriodEnd, subscription.billingCycle);
        subscription.currentPeriodStart = subscription.currentPeriodEnd;
        subscription.currentPeriodEnd = nextPeriodEnd;
        subscription.status = "Active";
        subscription.timeline.push({ event: "SubscriptionRenewed", description: "Free plan auto-renewed with no payment required.", performedBy: "system" });
        await subscription.save();
        return await SubscriptionRenewalEngineService.completeAsRenewed(renewal, { invoiceId: null, paymentAttemptId: null, paymentMethod: null, subscriptionId: subscription._id, startTime });
      }

      // Reuse an already-Sent invoice for this exact period (e.g. the daily
      // sweep already generated one inside its lead window, or a prior
      // attempt on THIS renewal row already did) — never a duplicate
      // invoice for the same period ("No payment without invoice").
      let invoice = renewal.invoiceId
        ? await SubscriptionInvoiceModel.findOne({ _id: renewal.invoiceId })
        : await SubscriptionInvoiceModel.findOne({ subscriptionId: subscription._id, billingPeriodStart: subscription.currentPeriodEnd, status: { $in: ["Sent", "Overdue"] } }).sort({ createdAt: -1 });

      if (!invoice) {
        const nextPeriodEnd = addBillingCycle(subscription.currentPeriodEnd, subscription.billingCycle);
        const invoiceJson = await TenantSubscriptionService.generateInvoice(subscription, { periodStart: subscription.currentPeriodEnd, periodEnd: nextPeriodEnd, invoiceType: "Renewal" });
        invoice = await SubscriptionInvoiceModel.findOne({ _id: invoiceJson._id });

        const amounts = await SubscriptionRenewalEngineService._computeRenewalAmount(subscription, billingAccount);
        if (amounts.promotionalCreditApplied > 0) {
          await MerchantAccountService.debitWallet(billingAccount.merchantAccountId, { balanceType: "Promotional", amount: amounts.promotionalCreditApplied, reason: `Applied to subscription renewal invoice ${invoice.invoiceNumber}.`, referenceId: invoice._id, userId: "system" });
        }
        if (amounts.finalAmount !== invoice.amount) {
          invoice.amount = amounts.finalAmount;
          invoice.timeline.push({ event: "InvoiceAdjusted", description: `Adjusted to ${amounts.finalAmount} ${invoice.currency} after promotional credit (${amounts.promotionalCreditApplied}) and late fee (${amounts.lateFeeAmount}).`, performedBy: "system" });
          await invoice.save();
        }

        renewal.invoiceId = invoice._id;
        renewal.subtotal = amounts.subtotal; renewal.discountAmount = amounts.discountAmount; renewal.promotionalCreditApplied = amounts.promotionalCreditApplied;
        renewal.lateFeeAmount = amounts.lateFeeAmount; renewal.taxAmount = amounts.taxAmount; renewal.finalAmount = amounts.finalAmount;
        renewal.status = "InvoiceGenerated";
        renewal.timeline.push({ event: "RenewalInvoiceGenerated", description: `Invoice ${invoice.invoiceNumber} for ${amounts.finalAmount} ${invoice.currency}.` });
        await renewal.save();

        await publishVersionedEvent({ eventName: "RenewalInvoiceGenerated", version: 1, category: "Domain", owner: EVENT_OWNER, source: EVENT_OWNER, tenantId: subscription.tenantId, data: { renewalId: renewal.renewalId, invoiceId: invoice._id.toString(), amount: amounts.finalAmount, currency: invoice.currency } });
      }

      // Fully covered by promotional credit — a real, immediate success, no gateway call needed.
      if (renewal.finalAmount <= 0) {
        await TenantSubscriptionService.recordManualPayment(invoice._id, { reference: "Fully covered by promotional credit.", userId: "system", paymentMethod: "Wallet" });
        return await SubscriptionRenewalEngineService.completeAsRenewed(renewal, { invoiceId: invoice._id, paymentAttemptId: "Wallet", paymentMethod: "Wallet", subscriptionId: subscription._id, startTime });
      }

      renewal.status = "PaymentAttempted";
      await renewal.save();

      // "Payment Priority... Primary Method." Only Stripe has a genuine
      // automatic gateway integration anywhere in this codebase (the same
      // fact utils/platformConfig.js's own doc comment already establishes)
      // — a real "Secondary Method" automatic fallback would be fictional
      // since no second real gateway exists; a non-Stripe billing account
      // honestly fails here exactly as chargeAutoDebit already does, and
      // falls straight into the real Payment Retry Engine below.
      const chargeResult = await TenantSubscriptionService.chargeAutoDebit(invoice._id, "system");
      if (chargeResult.status === "Paid") {
        await publishVersionedEvent({ eventName: "RenewalPaymentSucceeded", version: 1, category: "Domain", owner: EVENT_OWNER, source: EVENT_OWNER, tenantId: subscription.tenantId, data: { renewalId: renewal.renewalId, invoiceId: invoice._id.toString(), amount: renewal.finalAmount, gateway: "Stripe" } });
        return await SubscriptionRenewalEngineService.completeAsRenewed(renewal, { invoiceId: invoice._id, paymentAttemptId: chargeResult.stripeChargeId || null, paymentMethod: "Stripe", subscriptionId: subscription._id, startTime });
      }

      // "Payment Attempt -> Success? NO -> Retry Engine" — Automation #3
      // (Enterprise Payment Retry Strategy) owns the retry-vs-exhaust
      // decision from here; it calls SubscriptionRenewalEngineService.
      // completeAsFailed itself once genuinely exhausted/non-retryable.
      return await PaymentRetryEngineService.handleFailure(renewal, subscription._id, { failureReason: chargeResult.failureReason || "Automatic payment attempt failed.", paymentMethod: "Stripe" }, startTime);
    } catch (error) {
      return await PaymentRetryEngineService.handleFailure(renewal, subscription._id, { failureReason: error.message, paymentMethod: null }, startTime);
    }
  }

  /**
   * The scheduler's own real logic — "For every merchant: Find Active
   * Subscription -> Check Due Date -> ... -> Attempt Payment." Cursor-based
   * (never loads every due subscription into memory at once) and each
   * tenant's own renewal is isolated in its own try/catch, same discipline
   * as Automation #1's own `enforceGracePeriodSuspensions`. Deliberately
   * scoped to `Active`/`PastDue` subscriptions only — once a subscription
   * has already entered `GracePeriod`, that is Automation #1's (and,
   * eventually, Automation #3's Payment Retry Strategy) territory; this
   * engine's own job is the FIRST automatic attempt on the actual due date,
   * not competing with the grace/suspension flow that follows a failure.
   */
  static async runAutomaticRenewalSweep() {
    const config = getPlatformConfig();
    const now = new Date();
    const results = { processed: 0, renewed: 0, failed: 0 };

    const cursor = TenantSubscriptionModel.find({
      status: { $in: ["Active", "PastDue"] }, autoRenew: true,
      currentPeriodEnd: { $lte: new Date(now.getTime() + config.renewalEarlyWindowDays * 86400000) }
    }).cursor({ batchSize: config.subscriptionScanBatchSize });

    for await (const subscription of cursor) {
      results.processed += 1;
      try {
        const { renewal, duplicate } = await SubscriptionRenewalEngineService.processRenewal(subscription._id, { triggeredBy: "scheduler" });
        if (!duplicate && renewal.status === "Renewed") results.renewed += 1;
        else if (!duplicate && renewal.status === "Failed") results.failed += 1;
      } catch (error) {
        results.failed += 1;
        logger.error(`Automatic renewal failed for subscription ${subscription._id}.`, { error: error.message });
      }
    }

    return results;
  }
}

export default SubscriptionRenewalEngineService;
