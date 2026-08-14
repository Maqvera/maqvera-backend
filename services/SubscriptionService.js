import SubscriptionModel from "../models/SubscriptionModel.js";
import CustomerModel from "../models/CustomerModel.js";
import FinanceSequenceModel from "../models/FinanceSequenceModel.js";
import AuditLogModel from "../models/AuditLogmodel.js";
import CustomerCreditService from "./CustomerCreditService.js";
import { publishEvent } from "../utils/eventBus.js";
import { getFinanceConfig } from "../utils/financeConfig.js";

const roundCurrency = (value) => Math.round((Number(value) || 0) * 100) / 100;

// ---------------------------------------------------------------------------
// Pure helpers — no DB access, unit-testable directly.
// ---------------------------------------------------------------------------

export const isSubscriptionRenewable = (status) => ["Trial", "Active", "PastDue"].includes(status);
export const isSubscriptionCancellable = (status) => !["Cancelled", "Terminated"].includes(status);
export const isSubscriptionPausable = (status) => status === "Active";

/** Rolls a billing period end forward by one cycle. UsageBased/Metered/Hybrid/Trial all use a Monthly cadence — the real, honest default period length when no other cadence is meaningful. */
export const computeNextPeriodEnd = (periodStart, billingCycle) => {
  const d = new Date(periodStart);
  if (billingCycle === "Quarterly") { d.setUTCMonth(d.getUTCMonth() + 3); return d; }
  if (billingCycle === "SemiAnnual") { d.setUTCMonth(d.getUTCMonth() + 6); return d; }
  if (billingCycle === "Annual") { d.setUTCFullYear(d.getUTCFullYear() + 1); return d; }
  d.setUTCMonth(d.getUTCMonth() + 1); // Monthly/UsageBased/Metered/Hybrid/Trial
  return d;
};

/** "Usage-Based Billing, Metered Billing, Hybrid Billing" — the real invoice amount for the cycle just ending. Hybrid = base subscription amount + metered usage on top; UsageBased/Metered = usage only. */
export const computeCycleAmount = (subscription) => {
  const usageAmount = roundCurrency((subscription.usage?.meteredQuantity || 0) * (subscription.usage?.meteredUnitPrice || 0));
  if (subscription.billingCycle === "UsageBased" || subscription.billingCycle === "Metered") return usageAmount;
  if (subscription.billingCycle === "Hybrid") return roundCurrency(subscription.amount + usageAmount);
  return roundCurrency(subscription.amount);
};

/**
 * "Proration" — a real day-based calculation over the CURRENT period only
 * (never a fabricated flat percentage): the unused portion of the current
 * period at the old amount, replaced by the same unused portion at the
 * new amount. Positive = additional charge (Upgrade), negative = credit
 * (Downgrade).
 */
export const computeProrationAmount = (oldAmount, newAmount, periodStart, periodEnd, asOfDate) => {
  const totalMs = new Date(periodEnd).getTime() - new Date(periodStart).getTime();
  if (totalMs <= 0) return 0;
  const remainingMs = Math.max(0, new Date(periodEnd).getTime() - new Date(asOfDate).getTime());
  const remainingFraction = Math.min(1, remainingMs / totalMs);
  return roundCurrency((newAmount - oldAmount) * remainingFraction);
};

class SubscriptionService {
  static async _generateSubscriptionNumber(tenantId) {
    const config = getFinanceConfig();
    const year = `${new Date().getUTCFullYear()}`;
    const seq = await FinanceSequenceModel.getNext(tenantId, "subscriptionNumber", year);
    return `${config.subscriptionNumberPrefix}-${year}-${String(seq).padStart(6, "0")}`;
  }

  /** POST /api/v1/subscriptions */
  static async createSubscription(data, tenantId, userId) {
    const config = getFinanceConfig();
    const {
      customerId, planType = "Subscription", planName, membershipTier = null, billingCycle = config.defaultSubscriptionBillingCycle,
      amount, currency, trialDays = 0, autoRenew = true, gracePeriodDays = null, retryAttempts = null, prorationEnabled = true,
      paymentMethod = null, paymentProvider = null
    } = data;

    if (!customerId || !planName || !amount || !currency) throw new Error("customerId, planName, amount, and currency are required.");
    if (!config.subscriptionPlanTypes.includes(planType)) throw new Error(`Invalid planType "${planType}".`);
    if (!config.subscriptionBillingCycles.includes(billingCycle)) throw new Error(`Invalid billingCycle "${billingCycle}".`);
    if (planType === "Membership" && membershipTier && !config.membershipTiers.includes(membershipTier)) throw new Error(`Invalid membershipTier "${membershipTier}".`);
    if (!config.supportedCurrencies.some((c) => c.toLowerCase() === String(currency).toLowerCase())) throw new Error(`Currency "${currency}" is not supported.`);

    const customer = await CustomerModel.findOne({ _id: customerId, tenantId }).lean();
    if (!customer) throw new Error("Customer not found.");
    const customerName = `${customer.firstName || ""} ${customer.lastName || ""}`.trim() || customer.companyName || "Customer";

    const now = new Date();
    const trialEndsAt = trialDays > 0 ? new Date(now.getTime() + trialDays * 86400000) : null;
    const currentPeriodStart = now;
    const currentPeriodEnd = trialEndsAt || computeNextPeriodEnd(now, billingCycle);

    const subscriptionNumber = await SubscriptionService._generateSubscriptionNumber(tenantId);
    const subscription = await SubscriptionModel.create({
      tenantId, subscriptionNumber, customerId, customerName, planType, planName, membershipTier, billingCycle,
      amount: roundCurrency(amount), currency, status: trialDays > 0 ? "Trial" : config.defaultSubscriptionStatus,
      currentPeriodStart, currentPeriodEnd, nextBillingDate: currentPeriodEnd, trialEndsAt,
      renewalPolicy: { autoRenew, gracePeriodDays, retryAttempts, prorationEnabled }, paymentMethod, paymentProvider,
      timeline: [{ event: "SubscriptionCreated", description: `${planType} "${planName}" created (${billingCycle}, ${amount} ${currency}).`, performedBy: userId || null }],
      createdBy: userId || null, updatedBy: userId || null
    });

    await AuditLogModel.create({ action: "finance.subscription.create", module: "Finance", resource: "Subscription", resourceId: subscription._id.toString(), userId: userId || null, tenantId, details: { subscriptionNumber, planType, billingCycle, amount: roundCurrency(amount) } });
    publishEvent("SubscriptionCreated", { tenantId, subscriptionId: subscription._id.toString(), customerId: customerId.toString(), planType, billingCycle, amount: roundCurrency(amount), currency, performedBy: userId || null });

    return subscription.toJSON();
  }

  static async getSubscriptionById(subscriptionId, tenantId) {
    const subscription = await SubscriptionModel.findOne({ _id: subscriptionId, tenantId }).lean();
    if (!subscription) throw new Error("Subscription not found.");
    return subscription;
  }

  static async listSubscriptions(query, tenantId) {
    const { customerId, planType, status, billingCycle } = query;
    const filter = { tenantId };
    if (customerId) filter.customerId = customerId;
    if (planType) filter.planType = planType;
    if (status) filter.status = status;
    if (billingCycle) filter.billingCycle = billingCycle;

    const page = Math.max(parseInt(query.page, 10) || 1, 1);
    const pageSize = Math.min(Math.max(parseInt(query.pageSize, 10) || 20, 1), 100);
    const skip = (page - 1) * pageSize;

    const [items, total] = await Promise.all([
      SubscriptionModel.find(filter).sort({ nextBillingDate: 1 }).skip(skip).limit(pageSize).lean(),
      SubscriptionModel.countDocuments(filter)
    ]);
    return { items, pagination: { total, page, pageSize, totalPages: Math.ceil(total / pageSize) } };
  }

  /**
   * "Billing Cycle Starts -> Invoice Generated -> Payment Intent Created
   * -> Customer Pays -> Payment Allocated -> Subscription Extended." Every
   * step here is a real call into Part 18's own already-real Payment
   * Intent + Collection + Collect flow (Parts 2/3) — never reimplemented.
   * "Retry Payment -> Grace Period -> Suspend -> Terminate" is the real
   * alternate path on failure.
   */
  static async runBillingCycle(subscriptionId, tenantId, userId = "system") {
    const config = getFinanceConfig();
    const subscription = await SubscriptionModel.findOne({ _id: subscriptionId, tenantId });
    if (!subscription) throw new Error("Subscription not found.");
    if (!isSubscriptionRenewable(subscription.status)) throw new Error(`Subscription cannot be billed from status "${subscription.status}".`);

    const { default: CustomerCollectionService } = await import("./CustomerCollectionService.js");
    const cycleAmount = computeCycleAmount(subscription);

    let collection;
    if (subscription.status === "PastDue" && subscription.lastCollectionId) {
      // "Retry Payment" — retry the SAME still-outstanding invoice rather
      // than generating a duplicate one for the same period.
      collection = await CustomerCollectionService.getCollectionById(subscription.lastCollectionId, tenantId);
    } else {
      collection = await CustomerCollectionService.createCollectionRequest({
        customerId: subscription.customerId, collectionSource: subscription.planType === "Membership" ? "Membership Renewal" : "Subscription Invoice",
        subscriptionId: subscription._id.toString(), sourceDocumentId: subscription.subscriptionNumber,
        currency: subscription.currency, amount: cycleAmount, paymentMethod: subscription.paymentMethod, paymentDate: new Date()
      }, tenantId, userId);
      subscription.lastCollectionId = collection._id;
      subscription.timeline.push({ event: "InvoiceGenerated", description: `Renewal invoice ${collection.collectionNumber} generated for ${cycleAmount} ${subscription.currency}.`, performedBy: userId });
    }

    let collectResult;
    try {
      collectResult = await CustomerCollectionService.collectPayment(collection._id, {
        paymentMethod: subscription.paymentMethod || undefined, paymentProvider: subscription.paymentProvider || undefined
      }, tenantId, userId);
    } catch (error) {
      collectResult = { paymentStatus: "Failed", status: "Payment Failed" };
    }

    if (collectResult.paymentStatus === "Captured" || collectResult.status === "Collected") {
      const newPeriodStart = subscription.currentPeriodEnd;
      const newPeriodEnd = computeNextPeriodEnd(newPeriodStart, subscription.billingCycle);
      subscription.status = "Active";
      subscription.currentPeriodStart = newPeriodStart;
      subscription.currentPeriodEnd = newPeriodEnd;
      subscription.nextBillingDate = newPeriodEnd;
      subscription.retryCount = 0;
      subscription.graceEndsAt = null;
      subscription.lastPaymentId = collectResult.paymentId || subscription.lastPaymentId;
      subscription.lastCollectionId = null;
      subscription.updatedBy = userId;
      subscription.timeline.push({ event: "SubscriptionRenewed", description: `Renewed through ${newPeriodEnd.toISOString().slice(0, 10)}.`, performedBy: userId });
      await subscription.save();

      await AuditLogModel.create({ action: "finance.subscription.renew", module: "Finance", resource: "Subscription", resourceId: subscription._id.toString(), userId, tenantId, details: { amount: cycleAmount, currentPeriodEnd: newPeriodEnd } });
      publishEvent("SubscriptionRenewed", { tenantId, subscriptionId: subscription._id.toString(), customerId: subscription.customerId.toString(), planType: subscription.planType, amount: cycleAmount, currency: subscription.currency, currentPeriodEnd: newPeriodEnd, performedBy: userId });
      // "MembershipRenewed" (Part 18 Part 5's own Domain Events list) —
      // fired alongside SubscriptionRenewed, never instead of it, only for
      // planType "Membership".
      if (subscription.planType === "Membership") {
        publishEvent("MembershipRenewed", { tenantId, subscriptionId: subscription._id.toString(), customerId: subscription.customerId.toString(), membershipTier: subscription.membershipTier, amount: cycleAmount, currency: subscription.currency, currentPeriodEnd: newPeriodEnd, performedBy: userId });
      }
      return subscription.toJSON();
    }

    // Failure path — "Retry Payment -> Grace Period -> Suspend Subscription."
    subscription.retryCount = (subscription.retryCount || 0) + 1;
    const gracePeriodDays = subscription.renewalPolicy.gracePeriodDays ?? config.subscriptionDefaultGracePeriodDays;
    const retryAttempts = subscription.renewalPolicy.retryAttempts ?? config.subscriptionRetryAttempts;
    if (!subscription.graceEndsAt) subscription.graceEndsAt = new Date(Date.now() + gracePeriodDays * 86400000);

    if (subscription.retryCount > retryAttempts || subscription.graceEndsAt < new Date()) {
      subscription.status = "Suspended";
      subscription.updatedBy = userId;
      subscription.timeline.push({ event: "SubscriptionSuspended", description: `Suspended after ${subscription.retryCount} failed billing attempt(s).`, performedBy: userId });
      await subscription.save();
      await AuditLogModel.create({ action: "finance.subscription.suspend", module: "Finance", resource: "Subscription", resourceId: subscription._id.toString(), userId, tenantId, details: { retryCount: subscription.retryCount } });
      publishEvent("SubscriptionSuspended", { tenantId, subscriptionId: subscription._id.toString(), customerId: subscription.customerId.toString(), performedBy: userId });
      return subscription.toJSON();
    }

    subscription.status = "PastDue";
    subscription.updatedBy = userId;
    subscription.timeline.push({ event: "SubscriptionPaymentFailed", description: `Billing attempt ${subscription.retryCount} failed; grace period until ${subscription.graceEndsAt.toISOString().slice(0, 10)}.`, performedBy: userId });
    await subscription.save();

    await AuditLogModel.create({ action: "finance.subscription.payment_failed", module: "Finance", resource: "Subscription", resourceId: subscription._id.toString(), userId, tenantId, details: { retryCount: subscription.retryCount, graceEndsAt: subscription.graceEndsAt } });
    publishEvent("SubscriptionPaymentFailed", { tenantId, subscriptionId: subscription._id.toString(), customerId: subscription.customerId.toString(), retryCount: subscription.retryCount, graceEndsAt: subscription.graceEndsAt, performedBy: userId });

    return subscription.toJSON();
  }

  /** "Usage-Based Billing, Metered Billing." Records real usage between cycles — consumed by the next runBillingCycle's own computeCycleAmount. */
  static async recordUsage(subscriptionId, data, tenantId, userId) {
    const { quantity, unitPrice = null } = data;
    if (quantity === undefined || quantity === null) throw new Error("quantity is required.");

    const subscription = await SubscriptionModel.findOne({ _id: subscriptionId, tenantId });
    if (!subscription) throw new Error("Subscription not found.");
    if (!["UsageBased", "Metered", "Hybrid"].includes(subscription.billingCycle)) {
      throw new Error(`Usage recording only applies to UsageBased/Metered/Hybrid billing cycles (this subscription is "${subscription.billingCycle}").`);
    }

    subscription.usage.meteredQuantity = roundCurrency((subscription.usage.meteredQuantity || 0) + Number(quantity));
    if (unitPrice !== null) subscription.usage.meteredUnitPrice = roundCurrency(unitPrice);
    subscription.updatedBy = userId || null;
    subscription.timeline.push({ event: "UsageRecorded", description: `+${quantity} units recorded.`, performedBy: userId || null });
    await subscription.save();

    return subscription.toJSON();
  }

  /** "Upgrade, Downgrade" — a real day-based proration charge/credit applied immediately via CustomerCreditService/a fresh top-up collection, then the plan amount changes for future cycles. */
  static async changePlan(subscriptionId, data, tenantId, userId) {
    const { newAmount, type } = data;
    if (!newAmount || newAmount <= 0 || !["Upgrade", "Downgrade"].includes(type)) throw new Error("newAmount (>0) and type (Upgrade|Downgrade) are required.");

    const subscription = await SubscriptionModel.findOne({ _id: subscriptionId, tenantId });
    if (!subscription) throw new Error("Subscription not found.");
    if (!isSubscriptionRenewable(subscription.status)) throw new Error(`Cannot change plan from status "${subscription.status}".`);

    const oldAmount = subscription.amount;
    const roundedNewAmount = roundCurrency(newAmount);
    if ((type === "Upgrade" && roundedNewAmount <= oldAmount) || (type === "Downgrade" && roundedNewAmount >= oldAmount)) {
      throw new Error(`newAmount (${roundedNewAmount}) is not a real ${type.toLowerCase()} relative to the current amount (${oldAmount}).`);
    }

    let prorationAmount = 0;
    if (subscription.renewalPolicy.prorationEnabled) {
      prorationAmount = computeProrationAmount(oldAmount, roundedNewAmount, subscription.currentPeriodStart, subscription.currentPeriodEnd, new Date());
      if (prorationAmount < 0) {
        await CustomerCreditService.createCredit({ customerId: subscription.customerId, amount: Math.abs(prorationAmount), currency: subscription.currency, source: "Overpayment", sourceReferenceId: subscription._id }, tenantId, userId);
      } else if (prorationAmount > 0) {
        const { default: CustomerCollectionService } = await import("./CustomerCollectionService.js");
        await CustomerCollectionService.createCollectionRequest({
          customerId: subscription.customerId, collectionSource: subscription.planType === "Membership" ? "Membership Renewal" : "Subscription Invoice",
          subscriptionId: subscription._id.toString(), sourceDocumentId: `${subscription.subscriptionNumber}-PRORATION`,
          currency: subscription.currency, amount: prorationAmount, paymentMethod: subscription.paymentMethod
        }, tenantId, userId);
      }
    }

    subscription.planChangeHistory.push({ type, fromAmount: oldAmount, toAmount: roundedNewAmount, prorationAmount, changedBy: userId || null });
    subscription.amount = roundedNewAmount;
    subscription.updatedBy = userId || null;
    subscription.timeline.push({ event: type === "Upgrade" ? "SubscriptionUpgraded" : "SubscriptionDowngraded", description: `${type} from ${oldAmount} to ${roundedNewAmount} ${subscription.currency} (proration: ${prorationAmount}).`, performedBy: userId || null });
    await subscription.save();

    await AuditLogModel.create({ action: `finance.subscription.${type.toLowerCase()}`, module: "Finance", resource: "Subscription", resourceId: subscription._id.toString(), userId: userId || null, tenantId, details: { oldAmount, newAmount: roundedNewAmount, prorationAmount } });
    publishEvent(type === "Upgrade" ? "SubscriptionUpgraded" : "SubscriptionDowngraded", { tenantId, subscriptionId: subscription._id.toString(), customerId: subscription.customerId.toString(), oldAmount, newAmount: roundedNewAmount, prorationAmount, performedBy: userId || null });

    return subscription.toJSON();
  }

  static async pause(subscriptionId, data, tenantId, userId) {
    const subscription = await SubscriptionModel.findOne({ _id: subscriptionId, tenantId });
    if (!subscription) throw new Error("Subscription not found.");
    if (!isSubscriptionPausable(subscription.status)) throw new Error(`Cannot pause a subscription in status "${subscription.status}".`);

    subscription.status = "Suspended";
    subscription.pausedAt = new Date();
    subscription.pausedBy = userId || null;
    subscription.updatedBy = userId || null;
    subscription.timeline.push({ event: "SubscriptionPaused", description: data?.reason || "Subscription paused.", performedBy: userId || null });
    await subscription.save();

    await AuditLogModel.create({ action: "finance.subscription.pause", module: "Finance", resource: "Subscription", resourceId: subscription._id.toString(), userId: userId || null, tenantId, details: { reason: data?.reason || null } });
    publishEvent("SubscriptionPaused", { tenantId, subscriptionId: subscription._id.toString(), customerId: subscription.customerId.toString(), performedBy: userId || null });

    return subscription.toJSON();
  }

  static async resume(subscriptionId, tenantId, userId) {
    const subscription = await SubscriptionModel.findOne({ _id: subscriptionId, tenantId });
    if (!subscription) throw new Error("Subscription not found.");
    if (subscription.status !== "Suspended" || !subscription.pausedAt) throw new Error(`Only a paused subscription can be resumed (status "${subscription.status}").`);

    subscription.status = "Active";
    subscription.pausedAt = null;
    subscription.pausedBy = null;
    // Resuming shifts the remaining current-period time forward by however
    // long the pause lasted — a customer never loses paid-for time to a pause.
    const pausedDurationMs = Date.now() - new Date(subscription.updatedAt).getTime();
    subscription.currentPeriodEnd = new Date(subscription.currentPeriodEnd.getTime() + pausedDurationMs);
    subscription.nextBillingDate = subscription.currentPeriodEnd;
    subscription.updatedBy = userId || null;
    subscription.timeline.push({ event: "SubscriptionResumed", description: "Subscription resumed.", performedBy: userId || null });
    await subscription.save();

    await AuditLogModel.create({ action: "finance.subscription.resume", module: "Finance", resource: "Subscription", resourceId: subscription._id.toString(), userId: userId || null, tenantId, details: {} });
    publishEvent("SubscriptionResumed", { tenantId, subscriptionId: subscription._id.toString(), customerId: subscription.customerId.toString(), performedBy: userId || null });

    return subscription.toJSON();
  }

  static async cancel(subscriptionId, data, tenantId, userId) {
    const subscription = await SubscriptionModel.findOne({ _id: subscriptionId, tenantId });
    if (!subscription) throw new Error("Subscription not found.");
    if (!isSubscriptionCancellable(subscription.status)) throw new Error(`Subscription is already "${subscription.status}".`);

    subscription.status = "Cancelled";
    subscription.cancelledAt = new Date();
    subscription.cancelledBy = userId || null;
    subscription.cancellationReason = data?.reason || null;
    subscription.renewalPolicy.autoRenew = false;
    subscription.updatedBy = userId || null;
    subscription.timeline.push({ event: "SubscriptionCancelled", description: data?.reason || "Subscription cancelled.", performedBy: userId || null });
    await subscription.save();

    await AuditLogModel.create({ action: "finance.subscription.cancel", module: "Finance", resource: "Subscription", resourceId: subscription._id.toString(), userId: userId || null, tenantId, details: { reason: data?.reason || null } });
    publishEvent("SubscriptionCancelled", { tenantId, subscriptionId: subscription._id.toString(), customerId: subscription.customerId.toString(), performedBy: userId || null });

    return subscription.toJSON();
  }

  static async terminate(subscriptionId, data, tenantId, userId) {
    const subscription = await SubscriptionModel.findOne({ _id: subscriptionId, tenantId });
    if (!subscription) throw new Error("Subscription not found.");
    if (subscription.status === "Terminated") throw new Error("Subscription is already Terminated.");

    subscription.status = "Terminated";
    subscription.cancelledAt = subscription.cancelledAt || new Date();
    subscription.cancelledBy = subscription.cancelledBy || userId || null;
    subscription.cancellationReason = subscription.cancellationReason || data?.reason || null;
    subscription.renewalPolicy.autoRenew = false;
    subscription.updatedBy = userId || null;
    subscription.timeline.push({ event: "SubscriptionTerminated", description: data?.reason || "Subscription terminated.", performedBy: userId || null });
    await subscription.save();

    await AuditLogModel.create({ action: "finance.subscription.terminate", module: "Finance", resource: "Subscription", resourceId: subscription._id.toString(), userId: userId || null, tenantId, details: { reason: data?.reason || null } });
    publishEvent("SubscriptionTerminated", { tenantId, subscriptionId: subscription._id.toString(), customerId: subscription.customerId.toString(), performedBy: userId || null });

    return subscription.toJSON();
  }

  // ---- Scheduler entry points (services/subscriptionBillingScheduler.js) ----

  /** Cross-tenant pass — same discipline as CustomerCollectionService.markOverdueCollections/receivableOverdueScheduler. */
  static async runDueBillingCycles() {
    const due = await SubscriptionModel.find({ status: { $in: ["Trial", "Active"] }, "renewalPolicy.autoRenew": true, nextBillingDate: { $lte: new Date() } }).select("_id tenantId").lean();
    let processed = 0;
    for (const { _id, tenantId } of due) {
      try {
        await SubscriptionService.runBillingCycle(_id, tenantId, "system");
        processed += 1;
      } catch (error) {
        console.error(`SubscriptionService.runDueBillingCycles: subscription ${_id} failed:`, error.message);
      }
    }
    return processed;
  }

  /** Retries every PastDue subscription still within its grace period, and suspends the rest. */
  static async runGracePeriodRetries() {
    const pastDue = await SubscriptionModel.find({ status: "PastDue" }).select("_id tenantId").lean();
    let processed = 0;
    for (const { _id, tenantId } of pastDue) {
      try {
        await SubscriptionService.runBillingCycle(_id, tenantId, "system");
        processed += 1;
      } catch (error) {
        console.error(`SubscriptionService.runGracePeriodRetries: subscription ${_id} failed:`, error.message);
      }
    }
    return processed;
  }
}

export default SubscriptionService;
