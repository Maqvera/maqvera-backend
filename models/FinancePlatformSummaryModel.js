import mongoose from "mongoose";

// Enterprise Finance Platform Master Blueprint & Summary — Part 20.
// Centralized telemetry, sub-platform statuses, enterprise metrics, and health snapshots.
// Tenant-scoped only — no branchId per Master Architecture rules.
const SubPlatformStatusSchema = new mongoose.Schema({
  name: { type: String, required: true }, // e.g. "FinancialAccounting", "FinancialOperations", "FinancialPlanning", "Treasury", "FinancialIntelligence", "Governance"
  status: { type: String, enum: ["Operational", "Degraded", "Maintenance"], default: "Operational" },
  totalRecords: { type: Number, default: 0 },
  activeIssuesCount: { type: Number, default: 0 }
}, { _id: false });

const FinancePlatformSummarySchema = new mongoose.Schema({
  tenantId: {
    type: String,
    required: true,
    index: true
  },
  summaryId: {
    type: String,
    required: true,
    unique: true,
    index: true
  },
  subPlatforms: {
    type: [SubPlatformStatusSchema],
    default: []
  },
  totalJournals: {
    type: Number,
    default: 0
  },
  totalInvoices: {
    type: Number,
    default: 0
  },
  totalPayments: {
    type: Number,
    default: 0
  },
  totalCashAvailable: {
    type: Number,
    default: 0
  },
  activeBudgetsCount: {
    type: Number,
    default: 0
  },
  governanceComplianceRate: {
    type: Number,
    default: 100.0 // percentage
  },
  lastAuditCheck: {
    type: Date,
    default: Date.now
  },
  lastUpdated: {
    type: Date,
    default: Date.now
  }
}, { timestamps: true });

FinancePlatformSummarySchema.index({ tenantId: 1, lastUpdated: -1 });

FinancePlatformSummarySchema.set("toJSON", {
  transform: (_, ret) => {
    delete ret.__v;
    return ret;
  }
});

const FinancePlatformSummaryModel = mongoose.model("finance_platform_summary", FinancePlatformSummarySchema);

export default FinancePlatformSummaryModel;
