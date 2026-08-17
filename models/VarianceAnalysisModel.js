import mongoose from "mongoose";

// Enterprise Variance Analysis — Finance Module Part 17.
// Automated comparison of Planned (Budget/Forecast) vs Actual GL & operational figures.
// Tenant-scoped only — no branchId per Master Architecture rules.
const CategoryVarianceSchema = new mongoose.Schema({
  category: { type: String, required: true },
  target: { type: Number, required: true },
  actual: { type: Number, required: true },
  variance: { type: Number, required: true },
  variancePct: { type: Number, required: true },
  favorable: { type: Boolean, required: true }
}, { _id: false });

const VarianceAnalysisSchema = new mongoose.Schema({
  tenantId: {
    type: String,
    required: true,
    index: true
  },
  varianceId: {
    type: String,
    required: true,
    unique: true,
    index: true
  },
  name: {
    type: String,
    required: true,
    index: true
  },
  varianceType: {
    type: String,
    enum: ["BudgetVsActual", "ForecastVsActual", "RevenueVariance", "ExpenseVariance", "ProfitVariance", "CashFlowVariance"],
    required: true,
    index: true
  },
  budgetId: {
    type: String,
    default: null,
    index: true
  },
  forecastId: {
    type: String,
    default: null,
    index: true
  },
  fiscalYear: {
    type: String,
    required: true,
    index: true
  },
  period: {
    type: String,
    default: null
  },
  currency: {
    type: String,
    required: true
  },
  targetAmount: {
    type: Number,
    required: true,
    default: 0
  },
  actualAmount: {
    type: Number,
    required: true,
    default: 0
  },
  varianceAmount: {
    type: Number,
    required: true,
    default: 0
  },
  variancePercentage: {
    type: Number,
    required: true,
    default: 0
  },
  favorable: {
    type: Boolean,
    default: true
  },
  categoryBreakdown: {
    type: [CategoryVarianceSchema],
    default: []
  },
  calculatedAt: {
    type: Date,
    default: Date.now
  },
  calculatedBy: {
    type: String,
    default: null
  }
}, { timestamps: true });

VarianceAnalysisSchema.index({ tenantId: 1, varianceType: 1, fiscalYear: 1 });
VarianceAnalysisSchema.index({ tenantId: 1, budgetId: 1 });

VarianceAnalysisSchema.set("toJSON", {
  transform: (_, ret) => {
    delete ret.__v;
    return ret;
  }
});

const VarianceAnalysisModel = mongoose.model("variance_analysis", VarianceAnalysisSchema);

export default VarianceAnalysisModel;
