import TenantSubscriptionModel from "../models/TenantSubscriptionModel.js";
import PlatformPlanModel from "../models/PlatformPlanModel.js";
import TenantBillingAccountModel from "../models/TenantBillingAccountModel.js";
import AuditLogModel from "../models/AuditLogmodel.js";
import CommunicationPlatformService from "./CommunicationPlatformService.js";
import { publishVersionedEvent } from "../utils/eventVersioning.js";
import { getPlatformConfig } from "../utils/platformConfig.js";
import CacheManager from "../utils/cacheManager.js";
import logger from "../utils/logger.js";

const EVENT_OWNER = "Enterprise Subscription Automation Layer";

/**
 * Enterprise Subscription Automation Layer — Automation #4 (Enterprise
 * Grace Period Engine). "Retries Exhausted -> Grace Period Starts -> Grace
 * Start Date -> Grace End Date -> Merchant Status -> GRACE_PERIOD." The
 * ONE real, shared entry point for starting a subscription's grace
 * period — called from two real places:
 *
 * 1. `SubscriptionRenewalEngineService.completeAsFailed` (Automations
 *    #2/#3) — the real, EVENT-DRIVEN trigger: grace starts the moment
 *    retries genuinely exhaust (or a failure is classified non-retryable),
 *    not on a delay, satisfying "Grace periods MUST begin only after
 *    retry exhaustion."
 * 2. `TenantSubscriptionService.runDailyLifecycleSweep`'s own step 2b,
 *    now a real SAFETY NET only (skips any subscription still genuinely
 *    in-flight through the renewal/retry pipeline) — recovers a
 *    subscription that, for whatever operational reason, never went
 *    through path 1.
 *
 * Never a second, competing grace mechanism — `TenantSubscriptionModel`
 * stays the one real place grace state lives, `PlatformPlanModel.gracePeriodDays`
 * stays the one real per-plan configuration source.
 *
 * **Access policy — stored and exposed, enforcement deliberately
 * deferred.** "During Grace Period... Full Access + Warning Banner | Read
 * Only | Limited Operations... depends on company policy." This service
 * resolves and records the real, config-driven `gracePeriodAccessPolicy`
 * (`platformConfig.gracePeriodAccessPolicies`, per-plan overridable) on
 * every grace start — but no route/module in this codebase actually
 * CONSULTS it to restrict a GracePeriod tenant's requests differently
 * from an Active one. That's Automation #6's own job (Subscription
 * Enforcement Middleware, not yet built) — building partial, ad-hoc
 * enforcement here, in a module that owns the grace STATE MACHINE, not
 * request-time authorization, would scatter the same decision across two
 * places. Storing the real, correct policy value now means Automation #6
 * has nothing left to invent when it lands.
 */
class GracePeriodEngineService {
  /** Real reminder send at the moment grace starts — reuses CommunicationPlatformService directly (the same real call TenantSubscriptionService's own _sendReminder makes), not a private cross-file call. */
  static async _sendGraceStartReminder(subscription, graceDays, billingAccount) {
    if (!billingAccount?.billingContactEmail) return false;
    try {
      await CommunicationPlatformService.requestCommunication({
        tenantId: subscription.tenantId, sourceModule: "Platform", channel: "Email",
        recipient: { email: billingAccount.billingContactEmail }, subject: "Subscription: GracePeriod",
        content: `Your subscription expired and is now in a ${graceDays}-day grace period, ending ${subscription.gracePeriodEndsAt.toISOString().slice(0, 10)}. Please renew to avoid suspension.`,
        priority: "High", userId: null
      });
      subscription.reminders.push({ sentAt: new Date(), channel: "Email", reason: "GracePeriod" });
      return true;
    } catch (error) {
      logger.error(`Grace-period start reminder failed for tenant ${subscription.tenantId}.`, { error: error.message });
      return false;
    }
  }

  /**
   * Idempotent — a subscription already in `GracePeriod` (or in a status
   * grace doesn't apply to: `Suspended`/`Cancelled`/`Expired`/`Archived`)
   * is a real, safe no-op, never a double-start or an accidental
   * grace-period restart on top of an already-suspended tenant.
   */
  static async startGracePeriod(subscriptionId, { reason = null, userId = "system" } = {}) {
    const subscription = await TenantSubscriptionModel.findOne({ _id: subscriptionId });
    if (!subscription) throw new Error("Subscription not found.");

    if (!["Active", "Trial", "PastDue"].includes(subscription.status)) {
      return { started: false, subscription: subscription.toJSON() };
    }

    const config = getPlatformConfig();
    const plan = await PlatformPlanModel.findOne({ _id: subscription.planId }).lean();
    const graceDays = Math.max(plan?.gracePeriodDays ?? config.defaultGracePeriodDays, 0);
    const accessPolicy = (plan?.gracePeriodAccessPolicy && config.gracePeriodAccessPolicies.includes(plan.gracePeriodAccessPolicy))
      ? plan.gracePeriodAccessPolicy
      : config.defaultGracePeriodAccessPolicy;

    const graceStart = new Date();
    const graceEnd = new Date(graceStart.getTime() + graceDays * 86400000);

    subscription.status = "GracePeriod";
    subscription.graceStartedAt = graceStart;
    subscription.gracePeriodEndsAt = graceEnd;
    subscription.updatedBy = userId;
    subscription.timeline.push({ event: "GracePeriodStarted", description: reason ? `Entered ${graceDays}-day grace period (${reason}).` : `Entered ${graceDays}-day grace period.`, performedBy: userId });

    const billingAccount = await TenantBillingAccountModel.findOne({ tenantId: subscription.tenantId }).lean();
    await GracePeriodEngineService._sendGraceStartReminder(subscription, graceDays, billingAccount);

    await subscription.save();

    await AuditLogModel.create({
      action: "GRACE_PERIOD_STARTED", module: "Platform", resource: "TenantSubscription", resourceId: subscription._id.toString(),
      userId: userId === "system" ? null : userId, tenantId: subscription.tenantId,
      details: { graceStart, graceEnd, graceDays, reason, accessPolicy }
    });
    await publishVersionedEvent({
      eventName: "GracePeriodStarted", version: 1, category: "Domain", owner: EVENT_OWNER, source: EVENT_OWNER,
      tenantId: subscription.tenantId, data: { subscriptionId: subscription._id.toString(), graceStart, graceEnd, graceDays, reason, accessPolicy }
    });

    await Promise.all([
      CacheManager.invalidate(`platform:subscription-enforcement:${subscription.tenantId}`),
      CacheManager.invalidate(`platform:subscription-summary:${subscription.tenantId}`)
    ]);

    return { started: true, subscription: subscription.toJSON() };
  }

  /**
   * "Grace Countdown... Grace Remaining -> 7 Days -> 6 Days -> ... -> 0 ->
   * Suspend." Real, continuously computable read — the spec's own "Grace
   * Metadata" JSON shape.
   */
  static async getGraceStatus(subscriptionId) {
    const subscription = await TenantSubscriptionModel.findOne({ _id: subscriptionId }).lean();
    if (!subscription) throw new Error("Subscription not found.");

    const inGrace = subscription.status === "GracePeriod";
    const daysRemaining = inGrace ? Math.max(0, Math.ceil((new Date(subscription.gracePeriodEndsAt) - Date.now()) / 86400000)) : null;

    return {
      tenantId: subscription.tenantId,
      status: subscription.status,
      graceStart: subscription.graceStartedAt,
      graceEnd: subscription.gracePeriodEndsAt,
      daysRemaining
    };
  }

  /**
   * "Alerts... 3 Days Left, 1 Day Left." A real, distinct, once-only
   * tracked milestone event/audit entry — layered on top of (never
   * replacing) the existing daily grace reminder email
   * (`TenantSubscriptionService.runDailyLifecycleSweep` step 3), which
   * still sends the actual message. Dedupe is real: `reminders[]` already
   * records every reminder ever sent for this subscription, keyed by
   * `reason` — a milestone already recorded never fires twice.
   */
  static async recordMilestoneIfDue(subscription, daysRemaining) {
    const config = getPlatformConfig();
    if (!config.graceReminderMilestoneDays.includes(daysRemaining)) return false;

    const milestoneReason = `GraceMilestone${daysRemaining}`;
    const alreadyRecorded = subscription.reminders.some((r) => r.reason === milestoneReason);
    if (alreadyRecorded) return false;

    subscription.reminders.push({ sentAt: new Date(), channel: "Email", reason: milestoneReason });

    await AuditLogModel.create({ action: "GRACE_REMINDER_SENT", module: "Platform", resource: "TenantSubscription", resourceId: subscription._id.toString(), userId: null, tenantId: subscription.tenantId, details: { daysRemaining } });
    await publishVersionedEvent({ eventName: "GraceReminderSent", version: 1, category: "Domain", owner: EVENT_OWNER, source: EVENT_OWNER, tenantId: subscription.tenantId, data: { subscriptionId: subscription._id.toString(), daysRemaining } });

    return true;
  }
}

export default GracePeriodEngineService;
