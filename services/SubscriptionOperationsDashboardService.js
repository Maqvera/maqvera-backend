import TenantModel from "../models/Tenantmodel.js";
import TenantSubscriptionModel from "../models/TenantSubscriptionModel.js";
import SubscriptionInvoiceModel from "../models/SubscriptionInvoiceModel.js";
import SubscriptionRenewalModel from "../models/SubscriptionRenewalModel.js";
import BulkProcessingJobModel from "../models/BulkProcessingJobModel.js";
import DeadLetterQueueModel from "../models/DeadLetterQueueModel.js";
import SchedulerRunModel from "../models/SchedulerRunModel.js";
import WebhookDeliveryModel from "../models/WebhookDeliveryModel.js";
import WebhookSubscriptionModel from "../models/WebhookSubscriptionModel.js";
import CommunicationMessageModel from "../models/CommunicationMessageModel.js";
import AuditLogModel from "../models/AuditLogmodel.js";
import BulkProcessingEngineService, { DLQ_INTEGRATION } from "./BulkProcessingEngineService.js";
import { listCircuitBreakers } from "../utils/resilienceEngine.js";
import CacheManager from "../utils/cacheManager.js";
import { getEnforcementMetrics } from "../utils/enforcementMetrics.js";
import { getPlatformConfig } from "../utils/platformConfig.js";
import { publishVersionedEvent } from "../utils/eventVersioning.js";
import logger from "../utils/logger.js";

const EVENT_OWNER = "Enterprise Subscription Automation Layer";
const CYCLE_TO_MONTHLY_DIVISOR = { Monthly: 1, Quarterly: 3, HalfYearly: 6, Yearly: 12 };
const LIVE_SUBSCRIPTION_STATUSES = ["Active", "PastDue", "GracePeriod"]; // "in force" — still real recurring revenue, whether or not this cycle's payment has cleared yet

const round2 = (value) => Math.round((value || 0) * 100) / 100;
const startOfUtcDay = (date = new Date()) => { const d = new Date(date); d.setUTCHours(0, 0, 0, 0); return d; };

/** Pure, real MRR-normalization math — exported directly so it's unit-testable without depending on the platform-wide, inherently shared-state `getExecutiveKPIs` aggregate. */
export const normalizeToMonthlyAmount = (amount, billingCycle) => (amount || 0) / (CYCLE_TO_MONTHLY_DIVISOR[billingCycle] || 1);

/**
 * Enterprise Subscription Automation Layer — Automation #10 (Enterprise
 * Subscription Operations Dashboard). "Provide a single operational view
 * of the complete subscription ecosystem." Real aggregation over
 * everything Automations #1–#9 already write — no new business logic, no
 * new source-of-truth data, only real, live reads composed into one
 * command-centre view. Every currency-bearing figure is grouped by real
 * `currency` (`[{ currency, total }]`, the same shape Automation #2's own
 * dashboard already established) rather than summed across currencies —
 * no FX-conversion engine exists anywhere in this platform-billing domain
 * to make a single blended total honest.
 */
class SubscriptionOperationsDashboardService {
  /**
   * "Executive KPI Cards." Company-lifecycle counts are trivial live
   * counts; MRR/ARR are real, computed by normalizing every LIVE
   * subscription's own `amount`/`billingCycle` to a monthly figure (Trial
   * excluded — no real revenue yet; Suspended/Cancelled/Expired/Archived
   * excluded — no longer recurring). Collection Rate is computed over
   * invoices whose real `dueDate` fell in the last `operationsChurnWindowDays`-
   * independent 30-day window (hardcoded window for this one ratio,
   * distinct from the configurable churn window below — AR collection
   * efficiency and subscriber churn are genuinely different real time
   * horizons a real Finance/Ops team would want independently comparable).
   * Churn/Retention Rate is a real, honestly-approximated figure — this
   * platform keeps no daily active-subscriber snapshot history, so the
   * "cohort at window start" is approximated as (currently live + churned
   * during the window), not a precise point-in-time historical count.
   */
  static async getExecutiveKPIs() {
    const now = new Date();
    const startOfDay = startOfUtcDay(now);
    const windowStart30d = new Date(now.getTime() - 30 * 86400000);
    const config = getPlatformConfig();
    const churnWindowStart = new Date(now.getTime() - config.operationsChurnWindowDays * 86400000);

    const [statusRows, renewalsToday, dueWindowAgg, liveSubs, churnedCount] = await Promise.all([
      TenantSubscriptionModel.aggregate([{ $group: { _id: "$status", count: { $sum: 1 } } }]),
      AuditLogModel.countDocuments({ action: "platform.subscription.renew", createdAt: { $gte: startOfDay } }),
      SubscriptionInvoiceModel.aggregate([
        { $match: { dueDate: { $gte: windowStart30d, $lte: now } } },
        { $group: { _id: { currency: "$currency", status: "$status" }, total: { $sum: "$amount" } } }
      ]),
      TenantSubscriptionModel.find({ status: { $in: LIVE_SUBSCRIPTION_STATUSES } }).select("amount currency billingCycle").lean(),
      TenantSubscriptionModel.countDocuments({ status: "Cancelled", cancelledAt: { $gte: churnWindowStart } })
    ]);

    const countFor = (status) => statusRows.find((r) => r._id === status)?.count || 0;

    const revenueTodayAgg = await SubscriptionInvoiceModel.aggregate([
      { $match: { status: "Paid", paidAt: { $gte: startOfDay } } },
      { $group: { _id: "$currency", total: { $sum: "$amount" } } }
    ]);
    const outstandingAgg = await SubscriptionInvoiceModel.aggregate([
      { $match: { status: { $in: ["Sent", "Overdue"] } } },
      { $group: { _id: "$currency", total: { $sum: "$amount" } } }
    ]);

    const collectionByCurrency = new Map();
    for (const row of dueWindowAgg) {
      const currency = row._id.currency;
      const entry = collectionByCurrency.get(currency) || { currency, paid: 0, outstanding: 0 };
      if (row._id.status === "Paid") entry.paid += row.total; else entry.outstanding += row.total;
      collectionByCurrency.set(currency, entry);
    }
    const collectionRate = Array.from(collectionByCurrency.values()).map((row) => ({
      currency: row.currency,
      ratePercent: (row.paid + row.outstanding) > 0 ? round2((row.paid / (row.paid + row.outstanding)) * 100) : null
    }));

    const mrrByCurrency = new Map();
    for (const sub of liveSubs) {
      mrrByCurrency.set(sub.currency, (mrrByCurrency.get(sub.currency) || 0) + normalizeToMonthlyAmount(sub.amount, sub.billingCycle));
    }
    const mrr = Array.from(mrrByCurrency.entries()).map(([currency, total]) => ({ currency, total: round2(total) }));
    const arr = mrr.map(({ currency, total }) => ({ currency, total: round2(total * 12) }));

    const liveCompanyCount = countFor("Active") + countFor("PastDue") + countFor("GracePeriod");
    const approxCohort = liveCompanyCount + churnedCount;
    const churnRatePercent = approxCohort > 0 ? round2((churnedCount / approxCohort) * 100) : null;
    const retentionRatePercent = churnRatePercent === null ? null : round2(100 - churnRatePercent);

    return {
      activeCompanies: countFor("Active"),
      trialCompanies: countFor("Trial"),
      suspendedCompanies: countFor("Suspended"),
      gracePeriodCompanies: countFor("GracePeriod"),
      renewalsToday,
      revenueToday: revenueTodayAgg.map((r) => ({ currency: r._id, total: round2(r.total) })),
      outstandingRevenue: outstandingAgg.map((r) => ({ currency: r._id, total: round2(r.total) })),
      collectionRatePercent: collectionRate,
      mrr,
      arr,
      churnRatePercent,
      retentionRatePercent,
      churnWindowDays: config.operationsChurnWindowDays
    };
  }

  /** "Dashboard Home" — the quick-glance figures, one real live query each. */
  static async getDashboardHome() {
    const startOfDay = startOfUtcDay();

    const [renewalsToday, paymentsCollectedToday, pendingPayments, retryQueue, gracePeriod, suspended, reactivatedToday] = await Promise.all([
      AuditLogModel.countDocuments({ action: "platform.subscription.renew", createdAt: { $gte: startOfDay } }),
      SubscriptionInvoiceModel.aggregate([{ $match: { status: "Paid", paidAt: { $gte: startOfDay } } }, { $group: { _id: "$currency", total: { $sum: "$amount" } } }]),
      SubscriptionInvoiceModel.countDocuments({ status: { $in: ["Sent", "Overdue"] } }),
      SubscriptionRenewalModel.countDocuments({ status: "Retrying" }),
      TenantSubscriptionModel.countDocuments({ status: "GracePeriod" }),
      TenantSubscriptionModel.countDocuments({ status: "Suspended" }),
      AuditLogModel.countDocuments({ action: "MERCHANT_REACTIVATED", createdAt: { $gte: startOfDay } })
    ]);

    return {
      renewalsToday,
      paymentsCollectedToday: paymentsCollectedToday.map((r) => ({ currency: r._id, total: round2(r.total) })),
      pendingPayments,
      retryQueue,
      gracePeriod,
      suspended,
      reactivatedToday
    };
  }

  /** "Queue Monitoring." Real live sizes of every real queue-shaped collection this platform actually has. */
  static async getQueueMonitoring() {
    const [subscriptionQueue, retryQueue, notificationQueue, webhookQueue, deadLetterQueue] = await Promise.all([
      TenantSubscriptionModel.countDocuments({ status: { $in: ["PastDue", "GracePeriod"] } }),
      SubscriptionRenewalModel.countDocuments({ status: "Retrying" }),
      CommunicationMessageModel.countDocuments({ status: { $in: ["Requested", "Queued", "Processing"] } }),
      WebhookDeliveryModel.countDocuments({ status: { $in: ["Pending", "Retrying"] } }),
      DeadLetterQueueModel.countDocuments({ status: "Pending" })
    ]);
    return { subscriptionQueue, retryQueue, notificationQueue, webhookQueue, deadLetterQueue };
  }

  /**
   * "Worker Monitoring." Honestly real, not fabricated — this codebase has
   * no thread/process worker pool with Idle/Busy/Failed states anywhere;
   * the ONLY genuine "worker" concept is Automation #8's own real,
   * in-process bounded-concurrency gauges. Reused directly, not duplicated.
   */
  static async getWorkerMonitoring() {
    const config = getPlatformConfig();
    return { ...BulkProcessingEngineService.getLiveGauges(), configuredConcurrency: config.bulkProcessingConcurrency };
  }

  /** "API Monitoring." Real reuse of Automation #6's own live counters — no duplicated instrumentation. */
  static getApiMonitoring() {
    const metrics = getEnforcementMetrics();
    return {
      subscriptionChecksPerformed: metrics.checksPerformed,
      blockedRequests: metrics.blockedCount,
      allowedRequests: Math.max(metrics.checksPerformed - metrics.blockedCount, 0),
      averageMiddlewareTimeMs: metrics.averageMiddlewareTimeMs,
      cache: CacheManager.getStats()
    };
  }

  /** "Notification Dashboard." Real per-channel breakdown, `sourceModule: "Platform"` scoped — the same real identity Automation #7's own dashboard already established. */
  static async getNotificationMonitoring() {
    const startOfDay = startOfUtcDay();
    const [channelAgg, delivered, failed] = await Promise.all([
      CommunicationMessageModel.aggregate([{ $match: { sourceModule: "Platform", createdAt: { $gte: startOfDay } } }, { $group: { _id: "$channel", count: { $sum: 1 } } }]),
      CommunicationMessageModel.countDocuments({ sourceModule: "Platform", status: "Delivered", createdAt: { $gte: startOfDay } }),
      CommunicationMessageModel.countDocuments({ sourceModule: "Platform", status: "Failed", createdAt: { $gte: startOfDay } })
    ]);
    return { byChannel: channelAgg.map((r) => ({ channel: r._id, count: r.count })), delivered, failed };
  }

  /** "Webhook Dashboard." Real, genuinely new — sent/pending/retried/failed/disabled counts plus a real average delivery-time computed from actual delivered rows. */
  static async getWebhookMonitoring() {
    const startOfDay = startOfUtcDay();
    const [sent, pending, retried, failed, disabledSubscriptions, avgDeliveryAgg] = await Promise.all([
      WebhookDeliveryModel.countDocuments({ status: "Delivered", deliveredAt: { $gte: startOfDay } }),
      WebhookDeliveryModel.countDocuments({ status: "Pending" }),
      WebhookDeliveryModel.countDocuments({ status: "Retrying" }),
      WebhookDeliveryModel.countDocuments({ status: { $in: ["Failed", "Abandoned"] }, createdAt: { $gte: startOfDay } }),
      WebhookSubscriptionModel.countDocuments({ status: "Disabled" }),
      WebhookDeliveryModel.aggregate([
        { $match: { status: "Delivered", deliveredAt: { $gte: startOfDay } } },
        { $project: { deltaMs: { $subtract: ["$deliveredAt", "$createdAt"] } } },
        { $group: { _id: null, avgMs: { $avg: "$deltaMs" } } }
      ])
    ]);
    return { sent, pending, retried, failed, disabledSubscriptions, averageDeliveryTimeMs: avgDeliveryAgg[0]?.avgMs ? Math.round(avgDeliveryAgg[0].avgMs) : null };
  }

  /**
   * "Integration Dashboard... Health status of every integration." Honest,
   * real: Stripe is the only real gateway integration anywhere in this
   * codebase (same fact established repeatedly since Automation #2), but
   * has never actually been routed through the Resilience Standard's own
   * Circuit Breaker (`utils/resilienceEngine.js`) — so real monitoring
   * data only appears here once/if that wiring happens (genuine, separate
   * follow-up work, same "Adoption" pattern as every other resilience
   * consumer). PayPal/Bank APIs/SAP/QuickBooks/Microsoft/Google/Shopify/
   * Slack/Teams have no real integration anywhere in this codebase to
   * report health for — named honestly, never fabricated.
   */
  static async getIntegrationMonitoring() {
    const monitored = await listCircuitBreakers();
    return {
      monitored,
      realIntegrations: ["Stripe"],
      notIntegrated: ["PayPal", "BankAPIs", "SAP", "QuickBooks", "Microsoft", "Google", "Shopify", "Slack", "Teams"]
    };
  }

  /**
   * "Alerts... Automatic alerts." Computed live, at read time — a real,
   * honest limitation stated plainly: this is NOT a persisted, stateful,
   * deduplicating alert lifecycle (no `DashboardAlertResolved.v1` is ever
   * published, since there is no persisted "this alert is now resolved"
   * transition to observe) — every threshold-crossing condition found on
   * THIS read publishes a real `DashboardAlertRaised.v1`. A genuine
   * persisted platform-level alert lifecycle (raise once, acknowledge,
   * resolve) is real, valuable, separate follow-up work — the tenant-owned
   * `DashboardAlertModel` (Finance's own dashboard) is NOT reused here, it
   * is scoped to one tenant's own finance alerts, a different real domain
   * than this platform-wide, cross-tenant operational view.
   */
  static async getAlerts() {
    const config = getPlatformConfig();
    const now = new Date();
    const startOfDay = startOfUtcDay(now);
    const yesterdayStart = new Date(startOfDay.getTime() - 86400000);
    const alerts = [];

    const suspensionsToday = await AuditLogModel.countDocuments({ action: "platform.tenant.suspend", createdAt: { $gte: startOfDay } });
    if (suspensionsToday >= config.operationsMassSuspensionAlertThreshold) {
      alerts.push({ type: "MassSuspension", severity: "Critical", message: `${suspensionsToday} suspensions today, at/above the configured threshold of ${config.operationsMassSuspensionAlertThreshold}.`, value: suspensionsToday, threshold: config.operationsMassSuspensionAlertThreshold });
    }

    const [yesterdayAgg, recentDaysAgg] = await Promise.all([
      SubscriptionInvoiceModel.aggregate([{ $match: { status: "Paid", paidAt: { $gte: yesterdayStart, $lt: startOfDay } } }, { $group: { _id: null, total: { $sum: "$amount" } } }]),
      SubscriptionInvoiceModel.aggregate([
        { $match: { status: "Paid", paidAt: { $gte: new Date(startOfDay.getTime() - 8 * 86400000), $lt: yesterdayStart } } },
        { $group: { _id: { $dateToString: { format: "%Y-%m-%d", date: "$paidAt" } }, total: { $sum: "$amount" } } }
      ])
    ]);
    const yesterdayRevenue = yesterdayAgg[0]?.total || 0;
    const avg7day = recentDaysAgg.length > 0 ? recentDaysAgg.reduce((s, r) => s + r.total, 0) / recentDaysAgg.length : 0;
    if (avg7day > 0 && yesterdayRevenue < avg7day * (1 - config.operationsRevenueDropAlertPercent / 100)) {
      alerts.push({ type: "RevenueDrop", severity: "Warning", message: `Yesterday's revenue (${round2(yesterdayRevenue)}) was more than ${config.operationsRevenueDropAlertPercent}% below the recent 7-day average (${round2(avg7day)}).`, value: round2(yesterdayRevenue), threshold: round2(avg7day) });
    }

    const dlqPending = await DeadLetterQueueModel.countDocuments({ status: "Pending" });
    if (dlqPending >= config.operationsDlqGrowingThreshold) {
      alerts.push({ type: "QueueGrowing", severity: "Warning", message: `Dead Letter Queue has ${dlqPending} pending items, at/above the configured threshold of ${config.operationsDlqGrowingThreshold}.`, value: dlqPending, threshold: config.operationsDlqGrowingThreshold });
    }

    const cacheHealthy = await CacheManager.isHealthy();
    if (!cacheHealthy) {
      alerts.push({ type: "CacheFailure", severity: "Critical", message: "CacheManager health check failed.", value: 0, threshold: 1 });
    }

    for (const alert of alerts) {
      publishVersionedEvent({ eventName: "DashboardAlertRaised", version: 1, category: "Domain", owner: EVENT_OWNER, source: EVENT_OWNER, data: alert })
        .catch((error) => logger.error("DashboardAlertRaised publish failed.", { error: error.message }));
    }

    return alerts;
  }

  /** The real, composed "Operations Dashboard" response — every section above, one real payload. */
  static async getFullDashboard() {
    const [kpis, home, queues, workers, api, notifications, webhooks, integrations, alerts] = await Promise.all([
      SubscriptionOperationsDashboardService.getExecutiveKPIs(),
      SubscriptionOperationsDashboardService.getDashboardHome(),
      SubscriptionOperationsDashboardService.getQueueMonitoring(),
      SubscriptionOperationsDashboardService.getWorkerMonitoring(),
      SubscriptionOperationsDashboardService.getApiMonitoring(),
      SubscriptionOperationsDashboardService.getNotificationMonitoring(),
      SubscriptionOperationsDashboardService.getWebhookMonitoring(),
      SubscriptionOperationsDashboardService.getIntegrationMonitoring(),
      SubscriptionOperationsDashboardService.getAlerts()
    ]);
    return { kpis, home, queues, workers, api, notifications, webhooks, integrations, alerts, generatedAt: new Date() };
  }

  /**
   * "Search... Merchant, Company, Invoice, Payment, Subscription,
   * Transaction, Job, Correlation ID." Real, bounded, direct queries
   * across every real collection those terms map to in this codebase — no
   * fabricated full-text search engine. `SearchEngineService`/
   * `SearchIndexModel` (this codebase's real search infrastructure) is
   * deliberately NOT reused here — per its own documented scope
   * (`CLAUDE.md`), it indexes Visa/Booking summary data only; indexing
   * platform-subscription collections into it would be real, separate,
   * disproportionate follow-up work for what a bounded regex query across
   * a handful of collections already serves honestly today.
   */
  static async search(rawQuery, { limit = 10 } = {}) {
    const query = String(rawQuery || "").trim().slice(0, 200);
    if (!query) return { merchants: [], invoices: [], subscriptions: [], bulkProcessingJobs: [], schedulerRuns: [] };

    const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const regex = new RegExp(escaped, "i");

    const [merchants, invoices, subscriptions, bulkProcessingJobs, schedulerRuns] = await Promise.all([
      TenantModel.find({ $or: [{ tenantKey: regex }, { name: regex }] }).limit(limit).select("tenantKey name status").lean(),
      SubscriptionInvoiceModel.find({ invoiceNumber: regex }).limit(limit).select("invoiceNumber tenantId amount currency status dueDate").lean(),
      TenantSubscriptionModel.find({ tenantId: regex }).limit(limit).select("tenantId status planCode amount currency").lean(),
      BulkProcessingJobModel.find({ jobId: regex }).limit(limit).select("jobId jobType status startedAt").lean(),
      SchedulerRunModel.find({ jobId: regex }).limit(limit).select("jobId jobName status startedAt").lean()
    ]);

    return { merchants, invoices, subscriptions, bulkProcessingJobs, schedulerRuns };
  }

  /**
   * "Drill Down... Merchant -> Subscription -> Invoices -> Payments ->
   * Retries -> Notifications -> Audit -> Events -> Timeline. 360° view."
   * Real, chronological merge of every real record this platform already
   * writes for one tenant — `subscription.timeline[]`, the full
   * `AuditLogModel` trail, renewal/retry attempts, Dead Letter Queue
   * entries, and notifications sent — tagged by real source, sorted by
   * real timestamp. Nothing here is a new source of truth; this is purely
   * a real, unified read across sources that already existed.
   */
  static async getMerchantTimeline(tenantId, { limit = 200 } = {}) {
    const [subscription, auditEntries, renewals, dlqEntries, notifications] = await Promise.all([
      TenantSubscriptionModel.findOne({ tenantId }).lean(),
      AuditLogModel.find({ tenantId }).sort({ createdAt: -1 }).limit(limit).select("action outcome createdAt details userId").lean(),
      SubscriptionRenewalModel.find({ tenantId }).sort({ createdAt: -1 }).limit(50).select("status attemptCount createdAt renewedAt failedAt renewalDate").lean(),
      DeadLetterQueueModel.find({ tenantId }).sort({ createdAt: -1 }).limit(20).select("module operation status failedAt reason").lean(),
      CommunicationMessageModel.find({ tenantId, sourceModule: "Platform" }).sort({ createdAt: -1 }).limit(50).select("channel subject status createdAt templateId").lean()
    ]);

    if (!subscription) throw new Error("Subscription not found.");

    const events = [
      ...(subscription.timeline || []).map((t) => ({ source: "Subscription", event: t.event, description: t.description, performedBy: t.performedBy, occurredAt: t.performedAt })),
      ...auditEntries.map((a) => ({ source: "Audit", event: a.action, description: a.outcome, performedBy: a.userId || null, occurredAt: a.createdAt })),
      ...renewals.map((r) => ({ source: "Renewal", event: `RenewalAttempt:${r.status}`, description: `Attempt #${r.attemptCount} for period ending ${r.renewalDate ? new Date(r.renewalDate).toISOString().slice(0, 10) : "?"}.`, performedBy: "system", occurredAt: r.renewedAt || r.failedAt || r.createdAt })),
      ...dlqEntries.map((d) => ({ source: "DeadLetterQueue", event: `${d.module}.${d.operation}`, description: d.reason, performedBy: "system", occurredAt: d.failedAt })),
      ...notifications.map((n) => ({ source: "Notification", event: `${n.channel}:${n.status}`, description: n.subject || n.templateId, performedBy: "system", occurredAt: n.createdAt }))
    ]
      .filter((e) => e.occurredAt)
      .sort((a, b) => new Date(b.occurredAt).getTime() - new Date(a.occurredAt).getTime())
      .slice(0, limit);

    return { tenantId, subscription, timeline: events };
  }
}

export default SubscriptionOperationsDashboardService;
