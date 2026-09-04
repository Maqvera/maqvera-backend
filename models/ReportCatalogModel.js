import mongoose from "mongoose";

/**
 * Reporting Platform Part 2 fix — Report Catalog. A single registry of
 * every report *type* (not generated report instance — FinancialReportModel
 * already owns those) so a report is a discoverable, owned, lifecycle-
 * tracked entity instead of an implicit string a developer has to already
 * know. `module` reuses the same dashboardModules vocabulary as
 * models/DashboardPreferenceModel.js/DashboardAlertModel.js/
 * KPIDefinitionModel.js (utils/dashboardConfig.js); `relatedKpiKeys` is an
 * optional forward-reference to models/KPIDefinitionModel.js's `kpiKey` —
 * no hard coupling, just documents which KPIs a report surfaces.
 */
const ReportCatalogSchema = new mongoose.Schema({
  tenantId: { type: String, required: true, index: true },
  reportKey: { type: String, required: true, index: true },
  name: { type: String, required: true },
  module: { type: String, required: true, index: true },
  category: { type: String, default: null },
  tags: { type: [String], default: [] },
  owner: { type: String, default: null },
  description: { type: String, default: null },
  // Config-driven (reportLifecycleStates): draft/review/published/deprecated/archived/retired.
  lifecycleState: { type: String, required: true, default: "draft", index: true },
  currentVersion: { type: Number, default: 1 },
  relatedKpiKeys: { type: [String], default: [] },
  createdBy: { type: String, default: null },
  updatedBy: { type: String, default: null }
}, { timestamps: true });

ReportCatalogSchema.index({ tenantId: 1, reportKey: 1 }, { unique: true });
ReportCatalogSchema.index({ tenantId: 1, module: 1, lifecycleState: 1 });

ReportCatalogSchema.set("toJSON", {
  transform: (_, ret) => {
    delete ret.__v;
    return ret;
  }
});

const ReportCatalogModel = mongoose.model("report_catalog", ReportCatalogSchema);

export default ReportCatalogModel;
