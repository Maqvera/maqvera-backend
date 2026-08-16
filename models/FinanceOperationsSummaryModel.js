import mongoose from "mongoose";

// Enterprise Financial Dashboard — Finance Module Part 25. Mirrors the
// existing, real `VisaAnalyticsSummaryModel`'s own shape exactly (same
// "one persisted daily read model per tenant, refreshed by KPIEngine"
// architecture Travel/Visa already proved) — a dashboard request never
// aggregates transactional tables inline; it reads this. Tenant-scoped
// only — no branchId.
const FinanceOperationsSummarySchema = new mongoose.Schema({
  tenantId: { type: String, required: true, index: true },
  summaryDate: { type: String, required: true, index: true },
  metrics: { type: mongoose.Schema.Types.Mixed, default: {} },
  kpis: { type: mongoose.Schema.Types.Mixed, default: {} },
  alerts: { type: [mongoose.Schema.Types.Mixed], default: [] },
  generatedAt: { type: Date, default: Date.now },
  lastRefreshedAt: { type: Date, default: Date.now },
  source: { type: String, default: "event-driven-kpi-engine" }
}, { timestamps: true });

FinanceOperationsSummarySchema.index({ tenantId: 1, summaryDate: 1 }, { unique: true });

const FinanceOperationsSummaryModel = mongoose.model("finance_operations_summary", FinanceOperationsSummarySchema);

export default FinanceOperationsSummaryModel;
