import mongoose from "mongoose";

// Enterprise Financial Forecasting — Finance Module Part 17.
// Multi-period forward projections, rolling forecasts, revenue/expense/cash flow forecasts.
// Tenant-scoped only — no branchId per Master Architecture rules.
const ForecastBucketSchema = new mongoose.Schema({
  period: { type: String, required: true }, // e.g. "2028-01" or "Q1 2028"
  projectedRevenue: { type: Number, default: 0 },
  projectedExpense: { type: Number, default: 0 },
  projectedProfit: { type: Number, default: 0 },
  projectedCashFlow: { type: Number, default: 0 },
  projectedAmount: { type: Number, default: 0 },
  confidence: { type: Number, default: 1.0 }, // 0.0 to 1.0 confidence score
  notes: { type: String, default: null }
}, { _id: false });

const FinancialForecastSchema = new mongoose.Schema({
  tenantId: {
    type: String,
    required: true,
    index: true
  },
  forecastId: {
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
  forecastType: {
    type: String,
    enum: ["Rolling", "Revenue", "Expense", "CashFlow", "Profit", "Demand", "Resource"],
    required: true,
    index: true
  },
  fiscalYear: {
    type: String,
    required: true,
    index: true
  },
  baseBudgetId: {
    type: String,
    default: null,
    index: true
  },
  currency: {
    type: String,
    required: true
  },
  methodology: {
    type: String,
    enum: ["LinearTrend", "MovingAverage", "GrowthRate", "RunRate", "HistoricalAverage", "Custom"],
    default: "LinearTrend"
  },
  growthRate: {
    type: Number,
    default: 0
  },
  startDate: {
    type: Date,
    default: null
  },
  endDate: {
    type: Date,
    default: null
  },
  buckets: {
    type: [ForecastBucketSchema],
    default: []
  },
  totalProjectedRevenue: {
    type: Number,
    default: 0
  },
  totalProjectedExpense: {
    type: Number,
    default: 0
  },
  totalProjectedProfit: {
    type: Number,
    default: 0
  },
  totalProjectedCashFlow: {
    type: Number,
    default: 0
  },
  confidenceLevel: {
    type: String,
    enum: ["Low", "Medium", "High"],
    default: "Medium"
  },
  status: {
    type: String,
    enum: ["Active", "Archived", "Superceded"],
    default: "Active",
    index: true
  },
  generatedBy: {
    type: String,
    default: null
  },
  notes: {
    type: String,
    default: null
  }
}, { timestamps: true });

FinancialForecastSchema.index({ tenantId: 1, forecastType: 1, fiscalYear: 1 });
FinancialForecastSchema.index({ tenantId: 1, status: 1 });

FinancialForecastSchema.set("toJSON", {
  transform: (_, ret) => {
    delete ret.__v;
    return ret;
  }
});

const FinancialForecastModel = mongoose.model("financial_forecast", FinancialForecastSchema);

export default FinancialForecastModel;
