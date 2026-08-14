import mongoose from "mongoose";

// Enterprise Treasury Liquidity Management & Forecasting — Part 18 (TMS).
// Cash forecasting, liquidity buffers, working capital, and funding requirements.
// Tenant-scoped only — no branchId per Master Architecture rules.
const ForecastBreakdownSchema = new mongoose.Schema({
  period: { type: String, required: true },
  date: { type: Date, required: true },
  incomingCash: { type: Number, required: true, default: 0 },
  outgoingCash: { type: Number, required: true, default: 0 },
  netCash: { type: Number, required: true, default: 0 },
  cumulativeCash: { type: Number, required: true, default: 0 }
}, { _id: false });

const TreasuryLiquidityForecastSchema = new mongoose.Schema({
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
  horizon: {
    type: String,
    enum: ["7-Day", "30-Day", "90-Day", "12-Month", "Custom"],
    required: true,
    default: "30-Day"
  },
  baseCurrency: {
    type: String,
    required: true,
    default: "USD"
  },
  startingLiquidity: {
    type: Number,
    required: true,
    default: 0
  },
  projectedReceipts: {
    type: Number,
    required: true,
    default: 0
  },
  projectedDisbursements: {
    type: Number,
    required: true,
    default: 0
  },
  endingLiquidity: {
    type: Number,
    required: true,
    default: 0
  },
  minimumBuffer: {
    type: Number,
    default: 0
  },
  shortfallAmount: {
    type: Number,
    default: 0
  },
  workingCapitalRatio: {
    type: Number,
    default: 1.0
  },
  forecastBreakdown: {
    type: [ForecastBreakdownSchema],
    default: []
  },
  status: {
    type: String,
    enum: ["Draft", "Active", "Archived"],
    default: "Active",
    index: true
  },
  notes: {
    type: String,
    default: null
  },
  generatedAt: {
    type: Date,
    default: Date.now
  },
  generatedBy: {
    type: String,
    default: null
  }
}, { timestamps: true });

TreasuryLiquidityForecastSchema.index({ tenantId: 1, status: 1, generatedAt: -1 });

TreasuryLiquidityForecastSchema.set("toJSON", {
  transform: (_, ret) => {
    delete ret.__v;
    return ret;
  }
});

const TreasuryLiquidityForecastModel = mongoose.model("treasury_liquidity_forecast", TreasuryLiquidityForecastSchema);

export default TreasuryLiquidityForecastModel;
