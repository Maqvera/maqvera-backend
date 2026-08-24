import mongoose from "mongoose";
import ReportUsageSummaryModel from "../models/ReportUsageSummaryModel.js";
import { subscribeEvent } from "../utils/eventBus.js";

/**
 * Reporting Platform Part 12 fix — Report Usage Analytics. Event-driven,
 * cache-collection-backed aggregation (mirrors services/KPIEngine.js's own
 * upsert-into-summary pattern) instead of live-querying raw view/export
 * events on every admin page load. Guarded on `readyState === 1` (same
 * convention as services/ReportTemplateService.js's resolveTemplate) so a
 * disconnected DB never throws from inside an event listener.
 */
const todayStr = () => new Date().toISOString().slice(0, 10);

class ReportUsageAnalyticsService {
  static init() {
    subscribeEvent("DashboardViewed", (payload) => this.recordView({ ...payload, resourceType: "Dashboard" }));
    subscribeEvent("DashboardExported", (payload) => this.recordExport({ ...payload, resourceType: "Dashboard" }));
    subscribeEvent("ReportGenerated", (payload) => this.recordView({ ...payload, resourceType: "Report" }));
    subscribeEvent("ReportExported", (payload) => this.recordExport({ ...payload, resourceType: "Report" }));
  }

  static async recordView({ tenantId, module, dashboardType, reportType, performedBy, resourceType }) {
    const reportKey = resourceType === "Report" ? reportType : dashboardType;
    if (!tenantId || !module || !reportKey || mongoose.connection?.readyState !== 1) return null;

    const update = {
      $inc: { viewCount: 1 },
      $set: { lastViewedAt: new Date() },
      $setOnInsert: { tenantId, module, reportKey, resourceType, periodDate: todayStr() }
    };
    if (performedBy) update.$addToSet = { uniqueUserIds: performedBy };

    return ReportUsageSummaryModel.findOneAndUpdate(
      { tenantId, module, resourceType, reportKey, periodDate: todayStr() },
      update,
      { upsert: true, new: true }
    );
  }

  static async recordExport({ tenantId, module, dashboardType, reportType, performedBy, resourceType }) {
    const reportKey = resourceType === "Report" ? reportType : dashboardType;
    if (!tenantId || !module || !reportKey || mongoose.connection?.readyState !== 1) return null;

    const update = {
      $inc: { exportCount: 1 },
      $set: { lastExportedAt: new Date() },
      $setOnInsert: { tenantId, module, reportKey, resourceType, periodDate: todayStr() }
    };
    if (performedBy) update.$addToSet = { uniqueUserIds: performedBy };

    return ReportUsageSummaryModel.findOneAndUpdate(
      { tenantId, module, resourceType, reportKey, periodDate: todayStr() },
      update,
      { upsert: true, new: true }
    );
  }

  static async getUsageSummary({ tenantId, module = null, resourceType = null, reportKey = null, days = 30 }) {
    if (!tenantId) throw new Error("tenantId is required.");

    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const query = { tenantId, periodDate: { $gte: since } };
    if (module) query.module = module;
    if (resourceType) query.resourceType = resourceType;
    if (reportKey) query.reportKey = reportKey;

    return ReportUsageSummaryModel.find(query).sort({ periodDate: -1 }).lean();
  }
}

export default ReportUsageAnalyticsService;
