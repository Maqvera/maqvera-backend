import mongoose from "mongoose";

/**
 * Reporting Platform Part 12 fix — Report Usage Analytics. A periodic
 * per-day aggregate (NOT a per-view row — "don't live-query on every admin
 * page load"), following the exact upsert-into-summary-collection pattern
 * services/KPIEngine.js already uses for TravelOperationsSummaryModel/
 * FinanceOperationsSummaryModel (findOneAndUpdate upsert keyed by
 * tenantId+summaryDate). `module` reuses the dashboardModules vocabulary
 * (utils/dashboardConfig.js); `reportKey` is either a dashboard's
 * `dashboardType` or a report's `reportType` — same free-text field either
 * way, `resourceType` disambiguates which.
 */
const ReportUsageSummarySchema = new mongoose.Schema({
  tenantId: { type: String, required: true, index: true },
  module: { type: String, required: true, index: true },
  reportKey: { type: String, required: true, index: true },
  resourceType: { type: String, required: true, enum: ["Dashboard", "Report"], index: true },
  periodDate: { type: String, required: true, index: true },
  viewCount: { type: Number, default: 0 },
  exportCount: { type: Number, default: 0 },
  uniqueUserIds: { type: [String], default: [] },
  lastViewedAt: { type: Date, default: null },
  lastExportedAt: { type: Date, default: null }
}, { timestamps: true });

ReportUsageSummarySchema.index({ tenantId: 1, module: 1, resourceType: 1, reportKey: 1, periodDate: 1 }, { unique: true });

ReportUsageSummarySchema.set("toJSON", {
  transform: (_, ret) => {
    delete ret.__v;
    return ret;
  }
});

const ReportUsageSummaryModel = mongoose.model("report_usage_summary", ReportUsageSummarySchema);

export default ReportUsageSummaryModel;
