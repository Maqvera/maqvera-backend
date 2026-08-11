import mongoose from "mongoose";

// Financial Periods — shared foundation for Part 3 (Journal) and Part 4
// (Ledger)'s "Posting allowed only in Open Period" business rule. Tenant is
// the only isolation boundary (no branchId — see
// docs/06-external-integrations/03-final-architecture-no-branches-rbac.md).
const FinancialPeriodSchema = new mongoose.Schema({
  tenantId: {
    type: String,
    required: true,
    index: true
  },
  // "Financial Periods: Daily, Monthly, Quarterly, Yearly, Custom Period" —
  // config-driven (utils/financeConfig.js), not a hardcoded schema enum,
  // matching this codebase's existing convention for config-driven fields.
  periodType: {
    type: String,
    required: true
  },
  financialYear: {
    type: String,
    required: true,
    index: true
  },
  startDate: {
    type: Date,
    required: true,
    index: true
  },
  endDate: {
    type: Date,
    required: true,
    index: true
  },
  status: {
    type: String,
    required: true,
    index: true
  },
  closedAt: {
    type: Date,
    default: null
  },
  closedBy: {
    type: String,
    default: null
  }
}, { timestamps: true });

FinancialPeriodSchema.index({ tenantId: 1, startDate: 1, endDate: 1 });

FinancialPeriodSchema.set("toJSON", {
  transform: (_, ret) => {
    delete ret.__v;
    return ret;
  }
});

const FinancialPeriodModel = mongoose.model("financial_period", FinancialPeriodSchema);

export default FinancialPeriodModel;
