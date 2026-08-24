import CommunicationMessageModel from "../models/CommunicationMessageModel.js";
import CommunicationAnalyticsSummaryModel from "../models/CommunicationAnalyticsSummaryModel.js";
import CacheManager from "../utils/cacheManager.js";
import { publishEvent, subscribeEvent } from "../utils/eventBus.js";
import logger from "../utils/logger.js";

const todayStr = () => new Date().toISOString().slice(0, 10);
const cacheKey = (tenantId) => `communication-analytics:summary:${tenantId}`;
const round2 = (value) => Math.round((Number(value) || 0) * 100) / 100;

// Every channel's "message actually delivered" terminal status — EmailPlatformService
// historically used "Sent" here (a schema-invalid value now fixed to "Delivered"
// like every other channel), kept in this list too as a defensive fallback in
// case a pre-existing, not-yet-migrated row still carries the old value.
const DELIVERED_STATUSES = ["Delivered", "Sent"];

/**
 * Enterprise Communication Platform — Analytics Engine (Part 14). Mirrors
 * services/FinanceAnalyticsEngine.js's own proven shape exactly: a persisted
 * daily summary (CommunicationAnalyticsSummaryModel), CacheManager-wrapped
 * reads, and a background "never aggregate transactional tables inline on a
 * dashboard request" refresh via queueMicrotask, triggered by the same real
 * domain events CommunicationPlatformService/EmailPlatformService/
 * SmsPlatformService/WhatsAppPlatformService already publish. Not a second,
 * parallel dashboard system.
 */
class CommunicationAnalyticsEngine {
  static initialized = false;

  static init() {
    if (this.initialized) return;
    this.initialized = true;

    const refreshEvents = [
      "CommunicationDelivered",
      "CommunicationFailed",
      "CommunicationCancelled",
      "CommunicationRetried",
      "ProviderSwitched",
      "EmailDelivered",
      "EmailFailed",
      "SMSDelivered",
      "SMSFailed",
      "WhatsAppDelivered",
      "WhatsAppFailed",
      "PushDelivered",
      "PushFailed"
    ];

    refreshEvents.forEach((eventName) =>
      subscribeEvent(eventName, ({ tenantId } = {}) => {
        if (!tenantId) return;
        queueMicrotask(() =>
          this.refreshSummary({ tenantId }).catch((error) => logger.error("Communication analytics refresh failed.", { tenantId, error: error.message }))
        );
      })
    );
  }

  /**
   * Real aggregation over CommunicationMessageModel — the only place this
   * queries the live transactional collection; every dashboard read goes
   * through the persisted summary below instead.
   */
  static async computeCommunicationMetrics({ tenantId }) {
    const [statusCounts, channelCounts, providerCounts, dlqCount, latencyAgg] = await Promise.all([
      CommunicationMessageModel.aggregate([
        { $match: { tenantId } },
        { $group: { _id: "$status", count: { $sum: 1 } } }
      ]),
      CommunicationMessageModel.aggregate([
        { $match: { tenantId } },
        {
          $group: {
            _id: "$channel",
            total: { $sum: 1 },
            delivered: { $sum: { $cond: [{ $in: ["$status", DELIVERED_STATUSES] }, 1, 0] } },
            failed: { $sum: { $cond: [{ $eq: ["$status", "Failed"] }, 1, 0] } }
          }
        }
      ]),
      CommunicationMessageModel.aggregate([
        { $match: { tenantId, provider: { $ne: null } } },
        { $group: { _id: "$provider", count: { $sum: 1 } } },
        { $sort: { count: -1 } }
      ]),
      CommunicationMessageModel.countDocuments({ tenantId, dlqId: { $ne: null } }),
      CommunicationMessageModel.aggregate([
        { $match: { tenantId, status: { $in: DELIVERED_STATUSES }, deliveredAt: { $ne: null } } },
        { $project: { latencyMs: { $subtract: ["$deliveredAt", "$createdAt"] } } },
        { $group: { _id: null, avgLatencyMs: { $avg: "$latencyMs" } } }
      ])
    ]);

    const byStatus = Object.fromEntries(statusCounts.map((s) => [s._id, s.count]));
    const totalMessages = statusCounts.reduce((sum, s) => sum + s.count, 0);
    const deliveredCount = DELIVERED_STATUSES.reduce((sum, key) => sum + (byStatus[key] || 0), 0);
    const failedCount = byStatus.Failed || 0;
    const queuedCount = byStatus.Queued || 0;
    const cancelledCount = byStatus.Cancelled || 0;
    const deliveryRate = totalMessages > 0 ? round2((deliveredCount / totalMessages) * 100) : 100.0;

    const byChannel = Object.fromEntries(channelCounts.map((c) => [
      c._id,
      { total: c.total, delivered: c.delivered, failed: c.failed, deliveryRate: c.total > 0 ? round2((c.delivered / c.total) * 100) : 100.0 }
    ]));

    const byProvider = providerCounts.map((p) => ({ provider: p._id, count: p.count }));

    return {
      totalMessages,
      deliveredCount,
      failedCount,
      queuedCount,
      cancelledCount,
      deliveryRate,
      byChannel,
      byProvider,
      dlqCount,
      avgDeliveryLatencyMs: latencyAgg[0]?.avgLatencyMs != null ? Math.round(latencyAgg[0].avgLatencyMs) : null
    };
  }

  static async refreshSummary({ tenantId }) {
    if (!tenantId) throw new Error("tenantId is required.");

    const metrics = await this.computeCommunicationMetrics({ tenantId });
    const date = todayStr();

    const summary = await CommunicationAnalyticsSummaryModel.findOneAndUpdate(
      { tenantId, summaryDate: date },
      { tenantId, summaryDate: date, metrics, generatedAt: new Date(), lastRefreshedAt: new Date() },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    await CacheManager.invalidatePattern(`communication-analytics:*:${tenantId}*`);
    publishEvent("CommunicationDashboardRefreshed", { tenantId });
    publishEvent("CommunicationKPICalculated", { tenantId });

    return summary;
  }

  static async ensureSummary({ tenantId }) {
    const date = todayStr();
    let summary = await CommunicationAnalyticsSummaryModel.findOne({ tenantId, summaryDate: date }).lean();
    if (!summary) {
      // Dashboard requests must never aggregate transactional tables inline.
      queueMicrotask(() => this.refreshSummary({ tenantId }).catch((error) => logger.error("Initial Communication analytics refresh failed.", { tenantId, error: error.message })));
    }
    return summary || { tenantId, summaryDate: date, metrics: {}, generatedAt: null, pendingRefresh: true };
  }

  static async getSummary({ tenantId }) {
    const key = cacheKey(tenantId);
    const { data, fromCache } = await CacheManager.getOrCompute(key, async () => this.ensureSummary({ tenantId }));
    return { summary: data, fromCache };
  }

  /**
   * Backward-compatible shape for the existing GET /communication/analytics
   * endpoint (CommunicationPlatformService.getCommunicationAnalytics) — now
   * cache-backed instead of live countDocuments calls on every hit.
   */
  static async getCommunicationAnalytics({ tenantId }) {
    const { summary } = await this.getSummary({ tenantId });
    const m = summary.metrics || {};
    return {
      totalMessages: m.totalMessages || 0,
      deliveredCount: m.deliveredCount || 0,
      failedCount: m.failedCount || 0,
      queuedCount: m.queuedCount || 0,
      cancelledCount: m.cancelledCount || 0,
      deliveryRate: m.deliveryRate ?? 100.0,
      byChannel: m.byChannel || {},
      byProvider: m.byProvider || [],
      dlqCount: m.dlqCount || 0,
      avgDeliveryLatencyMs: m.avgDeliveryLatencyMs ?? null,
      lastUpdated: summary.generatedAt || new Date(),
      pendingRefresh: summary.pendingRefresh || false
    };
  }

  /**
   * POST /api/v1/communication/analytics/refresh — synchronous "refresh now
   * and return the fresh summary," mirroring FinanceAnalyticsEngine's own
   * refreshDashboard.
   */
  static async refreshDashboard({ tenantId }) {
    await this.refreshSummary({ tenantId });
    return this.getCommunicationAnalytics({ tenantId });
  }
}

export default CommunicationAnalyticsEngine;
