import TenantSubscriptionModel from "../models/TenantSubscriptionModel.js";
import TenantBillingAccountModel from "../models/TenantBillingAccountModel.js";
import SubscriptionInvoiceModel from "../models/SubscriptionInvoiceModel.js";
import SubscriptionRenewalModel from "../models/SubscriptionRenewalModel.js";
import AuditLogModel from "../models/AuditLogmodel.js";
import TenantSubscriptionService, { roundCurrency } from "./TenantSubscriptionService.js";
import MerchantAccountService from "./MerchantAccountService.js";
import SubscriptionNotificationService from "./SubscriptionNotificationService.js";
import { classifyPaymentFailure } from "../utils/paymentRetryClassifier.js";
import { publishVersionedEvent } from "../utils/eventVersioning.js";
import { getPlatformConfig } from "../utils/platformConfig.js";
import logger from "../utils/logger.js";

const EVENT_OWNER = "Enterprise Subscription Automation Layer";

/**
 * Enterprise Subscription Automation Layer — Automation #3 (Enterprise
 * Payment Retry Strategy). "Yeh woh layer hai jo Automatic Renewal Engine
 * aur Grace Period Engine ke beech ka bridge hai." Owns the ENTIRE
 * retry-vs-exhaust decision for a failed renewal attempt: Automation #2
 * (`SubscriptionRenewalEngineService`) makes the first, immediate attempt
 * and — on failure — hands off here via `handleFailure`; this service
 * decides whether to schedule a real, long-horizon retry or terminally
 * fail the renewal (which then naturally re-enters Automation #1's own
 * grace-period flow). Success is never routed through this service at
 * all — a successful attempt (first or retry) always completes directly
 * via `SubscriptionRenewalEngineService.completeAsRenewed`, per the
 * spec's own workflow diagram ("Success? YES -> Renew -> Finish").
 *
 * Long-horizon scheduling uses the exact same honest, non-blocking
 * `nextRetryAt` + cron-sweep pattern already proven twice in this
 * codebase (Webhook retry escalation, Improvement 14; Automation #1's own
 * suspension enforcement) — never a blocking setTimeout across
 * hours/days.
 */
class PaymentRetryEngineService {
  /**
   * Called by `SubscriptionRenewalEngineService.processRenewal` (the
   * FIRST attempt) and by this service's own `attemptRetry` (every
   * subsequent one) whenever a payment attempt fails. Real, DB-persisted
   * attempt history (`renewal.attempts[]`), real classification
   * (`utils/paymentRetryClassifier.js`), and a real terminal decision:
   * schedule the next attempt, or exhaust into Automation #1's grace-period
   * flow via `SubscriptionRenewalEngineService.completeAsFailed`.
   */
  static async handleFailure(renewal, subscriptionId, { failureReason, paymentMethod = null }, startTime) {
    const config = getPlatformConfig();
    const classification = classifyPaymentFailure(failureReason);
    const attemptNumber = (renewal.attemptCount || 0) + 1;
    const maxAttempts = renewal.maxAttempts || config.paymentRetryMaxAttempts;

    renewal.attemptCount = attemptNumber;
    renewal.maxAttempts = maxAttempts;
    renewal.failureReason = failureReason;
    renewal.attempts.push({ attemptNumber, attemptedAt: new Date(), paymentMethod, status: "Failed", failureReason, classification });

    // Enterprise Notification Timeline (Automation #7) — "Payment Failed
    // -> Immediate Notification." Fires for every real failure, whether
    // this attempt turns out to be retryable or exhausts immediately —
    // the merchant always learns a charge failed right away, regardless
    // of what the retry engine decides to do next.
    const invoiceNumber = renewal.invoiceId ? (await SubscriptionInvoiceModel.findOne({ _id: renewal.invoiceId }).select("invoiceNumber").lean())?.invoiceNumber || "" : "";
    try {
      await SubscriptionNotificationService.sendPaymentFailedNotification(renewal.tenantId, {
        merchantName: renewal.tenantId, invoiceNumber, outstandingAmount: renewal.finalAmount, currency: renewal.currency, attemptNumber, reason: failureReason
      });
    } catch (error) {
      logger.error(`Payment-failed notification failed for tenant ${renewal.tenantId}.`, { error: error.message });
    }

    const exhausted = classification === "NonRetryable" || attemptNumber >= maxAttempts;

    if (exhausted) {
      await AuditLogModel.create({ action: "PAYMENT_RETRY", module: "Platform", resource: "SubscriptionRenewal", resourceId: renewal.renewalId, userId: null, tenantId: renewal.tenantId, details: { attempt: attemptNumber, result: "EXHAUSTED", reason: classification, failureReason } });
      await publishVersionedEvent({ eventName: "PaymentRetriesExhausted", version: 1, category: "Domain", owner: EVENT_OWNER, source: EVENT_OWNER, tenantId: renewal.tenantId, data: { renewalId: renewal.renewalId, subscriptionId: renewal.subscriptionId.toString(), attemptCount: attemptNumber, classification } });

      const { default: SubscriptionRenewalEngineService } = await import("./SubscriptionRenewalEngineService.js");
      return await SubscriptionRenewalEngineService.completeAsFailed(renewal, failureReason, startTime);
    }

    // "Attempt #2 After 24 Hours, Attempt #3 After 72 Hours, Attempt #4
    // After 7 Days, Final Attempt Configurable." attemptNumber here is the
    // attempt that JUST failed; scheduleIndex 0 is the delay before the
    // NEXT one (the 2nd overall attempt).
    const scheduleIndex = Math.min(attemptNumber - 1, config.paymentRetryScheduleSeconds.length - 1);
    const delaySeconds = config.paymentRetryScheduleSeconds[scheduleIndex] ?? 86400;
    const nextRetryAt = new Date(Date.now() + delaySeconds * 1000);

    renewal.status = "Retrying";
    renewal.nextRetryAt = nextRetryAt;
    renewal.timeline.push({ event: "PaymentRetryScheduled", description: `Attempt ${attemptNumber} failed (${classification}: ${failureReason}). Next retry scheduled for ${nextRetryAt.toISOString()}.` });
    await renewal.save();

    await AuditLogModel.create({ action: "PAYMENT_RETRY", module: "Platform", resource: "SubscriptionRenewal", resourceId: renewal.renewalId, userId: null, tenantId: renewal.tenantId, details: { attempt: attemptNumber, result: "FAILED", reason: classification, failureReason } });
    await publishVersionedEvent({ eventName: "PaymentRetryScheduled", version: 1, category: "Domain", owner: EVENT_OWNER, source: EVENT_OWNER, tenantId: renewal.tenantId, data: { renewalId: renewal.renewalId, subscriptionId: renewal.subscriptionId.toString(), retryNumber: attemptNumber + 1, scheduledAt: nextRetryAt, reason: classification, status: "PENDING" } });

    // Enterprise Notification Timeline (Automation #7) — "Retry Scheduled."
    // Only when a real future attempt will actually happen.
    try {
      await SubscriptionNotificationService.sendRetryScheduledNotification(renewal.tenantId, {
        merchantName: renewal.tenantId, invoiceNumber, outstandingAmount: renewal.finalAmount, currency: renewal.currency, nextRetryDate: nextRetryAt.toISOString().slice(0, 10)
      });
    } catch (error) {
      logger.error(`Retry-scheduled notification failed for tenant ${renewal.tenantId}.`, { error: error.message });
    }

    return { renewal: renewal.toJSON(), duplicate: false };
  }

  /**
   * One scheduled retry's own real unit of work. Re-checks Promotional
   * wallet coverage fresh (a merchant may have topped up between
   * attempts — never re-charged for an amount that's already covered),
   * then a real Stripe charge with a real, deterministic per-attempt
   * idempotency key ("Every retry uses Idempotency-Key so duplicate
   * charges cannot happen").
   */
  static async attemptRetry(renewalId) {
    const renewal = await SubscriptionRenewalModel.findOne({ _id: renewalId });
    if (!renewal) throw new Error("Renewal not found.");
    const startTime = renewal.startedAt.getTime();

    const { default: SubscriptionRenewalEngineService } = await import("./SubscriptionRenewalEngineService.js");

    // Defensive fallback — the invoice almost always already exists by the
    // time a retry is due (the first attempt's own gateway call is what
    // usually fails, not invoice generation). If it genuinely doesn't,
    // re-enter the full first-attempt flow (which reuses this SAME claimed
    // row via the real upsert key) rather than duplicating that logic here.
    if (!renewal.invoiceId) {
      return await SubscriptionRenewalEngineService.processRenewal(renewal.subscriptionId, { triggeredBy: "scheduler" });
    }

    const subscription = await TenantSubscriptionModel.findOne({ _id: renewal.subscriptionId });
    if (!subscription) throw new Error("Subscription not found.");
    const invoice = await SubscriptionInvoiceModel.findOne({ _id: renewal.invoiceId });
    if (!invoice) throw new Error("Renewal invoice not found.");

    const attemptNumber = (renewal.attemptCount || 0) + 1;
    await publishVersionedEvent({ eventName: "PaymentRetryStarted", version: 1, category: "Domain", owner: EVENT_OWNER, source: EVENT_OWNER, tenantId: renewal.tenantId, data: { renewalId: renewal.renewalId, attemptNumber } });

    if (invoice.status === "Paid") {
      // Already settled by a different path between scheduling and firing (e.g. a manual payment) — a real, honest no-op success.
      return await SubscriptionRenewalEngineService.completeAsRenewed(renewal, { invoiceId: invoice._id, paymentAttemptId: invoice.stripeChargeId || "Manual", paymentMethod: invoice.paymentMethod, subscriptionId: subscription._id, startTime });
    }

    // Real re-check: has more Promotional wallet credit landed since the
    // last attempt? Only acted on if it now genuinely covers the full
    // remaining amount — never a fabricated partial coverage.
    const billingAccount = await TenantBillingAccountModel.findOne({ tenantId: renewal.tenantId }).lean();
    if (invoice.amount > 0 && billingAccount?.merchantAccountId) {
      try {
        const wallet = await MerchantAccountService.getWallet(billingAccount.merchantAccountId);
        const available = roundCurrency(wallet?.balances?.promotional || 0);
        if (available >= invoice.amount) {
          await MerchantAccountService.debitWallet(billingAccount.merchantAccountId, { balanceType: "Promotional", amount: invoice.amount, reason: `Applied to subscription renewal invoice ${invoice.invoiceNumber} on retry #${attemptNumber}.`, referenceId: invoice._id, userId: "system" });
          await TenantSubscriptionService.recordManualPayment(invoice._id, { reference: `Fully covered by promotional credit on retry #${attemptNumber}.`, userId: "system", paymentMethod: "Wallet" });

          renewal.attemptCount = attemptNumber;
          renewal.attempts.push({ attemptNumber, attemptedAt: new Date(), paymentMethod: "Wallet", status: "Succeeded" });
          await publishVersionedEvent({ eventName: "PaymentRetrySucceeded", version: 1, category: "Domain", owner: EVENT_OWNER, source: EVENT_OWNER, tenantId: renewal.tenantId, data: { renewalId: renewal.renewalId, attemptNumber, paymentMethod: "Wallet" } });
          return await SubscriptionRenewalEngineService.completeAsRenewed(renewal, { invoiceId: invoice._id, paymentAttemptId: "Wallet", paymentMethod: "Wallet", subscriptionId: subscription._id, startTime });
        }
      } catch (error) {
        logger.warn(`Retry wallet-credit re-check failed for renewal ${renewal.renewalId}.`, { error: error.message });
      }
    }

    const idempotencyKey = `retry-${renewal.renewalId}-attempt-${attemptNumber}`;
    const chargeResult = await TenantSubscriptionService.chargeAutoDebit(invoice._id, "system", { idempotencyKey });

    if (chargeResult.status === "Paid") {
      renewal.attemptCount = attemptNumber;
      renewal.attempts.push({ attemptNumber, attemptedAt: new Date(), paymentMethod: "Stripe", status: "Succeeded", paymentAttemptId: chargeResult.stripeChargeId || null, idempotencyKey });
      await publishVersionedEvent({ eventName: "PaymentRetrySucceeded", version: 1, category: "Domain", owner: EVENT_OWNER, source: EVENT_OWNER, tenantId: renewal.tenantId, data: { renewalId: renewal.renewalId, attemptNumber, paymentMethod: "Stripe" } });
      return await SubscriptionRenewalEngineService.completeAsRenewed(renewal, { invoiceId: invoice._id, paymentAttemptId: chargeResult.stripeChargeId || null, paymentMethod: "Stripe", subscriptionId: subscription._id, startTime });
    }

    return await PaymentRetryEngineService.handleFailure(renewal, subscription._id, { failureReason: chargeResult.failureReason || "Retry payment attempt failed.", paymentMethod: "Stripe" }, startTime);
  }

  /**
   * The scheduler's own real logic — "Retry Queue -> Worker -> Payment
   * Gateway." Cursor-based (never loads the full due-retry set into
   * memory), and every due row is ATOMICALLY claimed
   * (`status: Retrying -> PaymentAttempted`) before any work happens — the
   * real idempotency guard against a concurrent/overlapping sweep ever
   * processing the same due retry twice. "Retry Isolation" — each
   * tenant's own retry is isolated in its own try/catch, so one
   * merchant's continuously-failing retries never block another's.
   */
  static async processDueRetries() {
    const config = getPlatformConfig();
    const now = new Date();
    const results = { processed: 0, renewed: 0, failed: 0 };

    const cursor = SubscriptionRenewalModel.find({ status: "Retrying", nextRetryAt: { $lte: now } }).cursor({ batchSize: config.paymentRetryPollBatchSize });

    for await (const row of cursor) {
      const claimed = await SubscriptionRenewalModel.findOneAndUpdate(
        { _id: row._id, status: "Retrying", nextRetryAt: { $lte: now } },
        { $set: { status: "PaymentAttempted", nextRetryAt: null } }
      );
      if (!claimed) continue; // Already claimed by a concurrent run — real, safe skip.

      results.processed += 1;
      try {
        const { renewal } = await PaymentRetryEngineService.attemptRetry(row._id);
        if (renewal.status === "Renewed") results.renewed += 1;
        else if (renewal.status === "Failed") results.failed += 1;
      } catch (error) {
        results.failed += 1;
        logger.error(`Payment retry attempt failed for renewal ${row._id}.`, { error: error.message });
      }
    }

    return results;
  }
}

export default PaymentRetryEngineService;
