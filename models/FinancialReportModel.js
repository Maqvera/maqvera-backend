import mongoose from "mongoose";

// Enterprise Financial Reporting — Finance Module Part 24. "Reports are
// generated from immutable accounting records." One row per real
// generation — `data` is never edited after creation; re-running the
// same report parameters later produces a NEW row (real, reproducible
// history, same discipline as Part 20's own TaxReportModel). Tenant-
// scoped only — no branchId.
const ReportExportSchema = new mongoose.Schema({
  format: { type: String, required: true },
  url: { type: String, required: true },
  storageKey: { type: String, default: null },
  storageProvider: { type: String, default: null },
  generatedAt: { type: Date, default: Date.now }
}, { _id: false });

const FinancialReportSchema = new mongoose.Schema({
  tenantId: {
    type: String,
    required: true,
    index: true
  },
  // Config-driven (reportTypes) — TrialBalance, BalanceSheet,
  // ProfitAndLoss, CashFlow, GeneralLedger, JournalRegister, ARAging,
  // APAging, TaxReport, BudgetVsActual, RetainedEarnings, Custom.
  reportType: { type: String, required: true, index: true },
  // Free-form label the caller supplied (e.g. "2027-Q2") — purely
  // descriptive; `periodStart`/`periodEnd` below are the real, resolved
  // date range actually used to query the ledger.
  period: { type: String, default: null },
  periodStart: { type: Date, default: null },
  periodEnd: { type: Date, default: null },
  asOfDate: { type: Date, default: null },
  currency: { type: String, default: null },
  // The real request parameters used to generate this report — kept for
  // full reproducibility (re-running them later should reconstruct the
  // same figures from the still-immutable ledger).
  parameters: { type: mongoose.Schema.Types.Mixed, default: {} },
  // The actual computed report content (rows/totals/sections) — never
  // edited after creation.
  data: { type: mongoose.Schema.Types.Mixed, required: true },
  // Config-driven (reportStatuses) — Requested, Generated, Cancelled,
  // Expired, Archived. See utils/financeConfig.js's own doc comment for
  // why "Validated"/"Data Retrieved"/"Aggregated"/"Exported" aren't
  // separate resting states here.
  status: { type: String, required: true, index: true },
  exports: { type: [ReportExportSchema], default: [] },
  expiresAt: { type: Date, default: null },
  generatedBy: { type: String, default: null },
  generatedAt: { type: Date, default: Date.now },
  timeline: [{
    event: { type: String, required: true },
    description: { type: String, default: null },
    performedBy: { type: String, default: null },
    performedAt: { type: Date, default: Date.now }
  }]
}, { timestamps: true });

FinancialReportSchema.index({ tenantId: 1, reportType: 1, generatedAt: -1 });
FinancialReportSchema.index({ tenantId: 1, status: 1 });

FinancialReportSchema.set("toJSON", {
  transform: (_, ret) => {
    delete ret.__v;
    return ret;
  }
});

const FinancialReportModel = mongoose.model("financial_report", FinancialReportSchema);

export default FinancialReportModel;
