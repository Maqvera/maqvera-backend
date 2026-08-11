import mongoose from "mongoose";

// Enterprise Financial Analytics — Finance Module Part 26. "Reports
// describe. Dashboards monitor. Analytics explains, predicts, and helps
// optimize." Mirrors `FinancialReportModel`'s own shape exactly — one row
// per real run, `kpis`/`series`/`forecasts`/`insights`/`recommendations`
// are never edited after creation; re-running the same parameters later
// produces a NEW row (identical "immutable history" discipline as Part
// 24's own FinancialReportModel/Part 20's TaxReportModel). Tenant-scoped
// only — no branchId.
const FinancialAnalyticsSchema = new mongoose.Schema({
  tenantId: {
    type: String,
    required: true,
    index: true
  },
  // Config-driven (analysisTypes) — RevenueTrend, RevenueForecast,
  // RevenueByCustomer, RecurringRevenue, ExpenseTrend, ExpenseForecast,
  // ExpenseCategories, CostDrivers, CashFlowForecast,
  // WorkingCapitalForecast, FinancialRatios, BudgetVsActual,
  // CurrentVsPrevious, ForecastVsActual, ScenarioPlanning,
  // AnomalyDetection, ExecutiveInsights, Custom.
  analysisType: { type: String, required: true, index: true },
  // Free-form label the caller supplied (e.g. "2027", "Next12Months") —
  // purely descriptive; `periodStart`/`periodEnd` (for historical
  // analyses) are the real, resolved date range actually queried against
  // the ledger. Forward-looking Forecast types instead populate
  // `forecasts[].bucketLabel`/`bucketEnd` per projected bucket.
  period: { type: String, default: null },
  periodStart: { type: Date, default: null },
  periodEnd: { type: Date, default: null },
  currency: { type: String, default: null },
  // The real request parameters used to run this analysis — kept for full
  // reproducibility, same reasoning as FinancialReportModel.parameters.
  parameters: { type: mongoose.Schema.Types.Mixed, default: {} },
  // Real computed KPIs for this analysis (ratios, growth rates, totals).
  kpis: { type: mongoose.Schema.Types.Mixed, default: {} },
  // Real bucketed historical series this analysis was computed from
  // (e.g. monthly Revenue/Expense/CashFlow buckets) — the "Charts" the
  // spec's own response shape names.
  series: { type: [mongoose.Schema.Types.Mixed], default: [] },
  // Real projected future buckets (Forecast/Scenario/CashFlow types only)
  // — each a deterministic linear-regression or what-if calculation over
  // `series`, never a fabricated value.
  forecasts: { type: [mongoose.Schema.Types.Mixed], default: [] },
  // Real, rule-based (or, for ExecutiveInsights, LLM-generated via the
  // already-wired AIModelRouterService) structured findings — never
  // fabricated when the AI call fails (`aiAvailable: false` instead).
  insights: { type: [mongoose.Schema.Types.Mixed], default: [] },
  recommendations: { type: [mongoose.Schema.Types.Mixed], default: [] },
  // "Low" | "Medium" | "High" — derived from real historical data-point
  // count (see utils/financeConfig.js analyticsConfidence*DataPoints),
  // never a fabricated precision claim.
  confidenceLevel: { type: String, default: null },
  // Config-driven (analyticsStatuses) — Completed, Cancelled, Archived,
  // Expired. See utils/financeConfig.js's own doc comment for why
  // "Validated"/"Aggregated"/"Model Applied"/"Published" aren't separate
  // resting states here.
  status: { type: String, required: true, index: true },
  expiresAt: { type: Date, default: null },
  error: { type: String, default: null },
  requestedBy: { type: String, default: null },
  generatedAt: { type: Date, default: Date.now },
  timeline: [{
    event: { type: String, required: true },
    description: { type: String, default: null },
    performedBy: { type: String, default: null },
    performedAt: { type: Date, default: Date.now }
  }]
}, { timestamps: true });

FinancialAnalyticsSchema.index({ tenantId: 1, analysisType: 1, generatedAt: -1 });
FinancialAnalyticsSchema.index({ tenantId: 1, status: 1 });

FinancialAnalyticsSchema.set("toJSON", {
  transform: (_, ret) => {
    delete ret.__v;
    return ret;
  }
});

const FinancialAnalyticsModel = mongoose.model("financial_analytics", FinancialAnalyticsSchema);

export default FinancialAnalyticsModel;
