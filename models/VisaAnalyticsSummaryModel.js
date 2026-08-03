import mongoose from "mongoose";

const VisaAnalyticsSummarySchema = new mongoose.Schema({
  tenantId: { type: String, required: true, index: true },
  branchId: { type: String, required: true, default: "main", index: true },
  summaryDate: { type: String, required: true, index: true },
  metrics: { type: mongoose.Schema.Types.Mixed, default: {} },
  kpis: { type: mongoose.Schema.Types.Mixed, default: {} },
  trends: { type: mongoose.Schema.Types.Mixed, default: {} },
  embassyMetrics: { type: [mongoose.Schema.Types.Mixed], default: [] },
  officerMetrics: { type: [mongoose.Schema.Types.Mixed], default: [] },
  complianceMetrics: { type: mongoose.Schema.Types.Mixed, default: {} },
  aiInsights: { type: mongoose.Schema.Types.Mixed, default: {} },
  financeMetrics: { type: mongoose.Schema.Types.Mixed, default: {} },
  generatedAt: { type: Date, default: Date.now },
  lastRefreshedAt: { type: Date, default: Date.now },
  source: { type: String, default: "event-driven-kpi-engine" }
}, { timestamps: true });

VisaAnalyticsSummarySchema.index({ tenantId: 1, branchId: 1, summaryDate: 1 }, { unique: true });

export default mongoose.model("visa_analytics_summary", VisaAnalyticsSummarySchema);
