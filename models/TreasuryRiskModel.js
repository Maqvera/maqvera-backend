import mongoose from "mongoose";

// Enterprise Treasury Risk Controls — Part 18 (TMS).
// Liquidity risk, interest rate risk, currency risk, counterparty risk, credit risk, concentration risk.
// Tenant-scoped only — no branchId per Master Architecture rules.
const TreasuryRiskSchema = new mongoose.Schema({
  tenantId: {
    type: String,
    required: true,
    index: true
  },
  riskId: {
    type: String,
    required: true,
    unique: true,
    index: true
  },
  riskType: {
    type: String,
    enum: ["LiquidityRisk", "InterestRateRisk", "CurrencyRisk", "CounterpartyRisk", "CreditRisk", "ConcentrationRisk"],
    required: true,
    index: true
  },
  severity: {
    type: String,
    enum: ["Low", "Medium", "High", "Critical"],
    required: true,
    default: "Low",
    index: true
  },
  metricName: {
    type: String,
    required: true
  },
  currentValue: {
    type: Number,
    required: true
  },
  thresholdValue: {
    type: Number,
    required: true
  },
  status: {
    type: String,
    enum: ["Normal", "Warning", "Breached", "Mitigated"],
    default: "Normal",
    index: true
  },
  mitigationPlan: {
    type: String,
    default: null
  },
  detectedAt: {
    type: Date,
    default: Date.now
  },
  resolvedAt: {
    type: Date,
    default: null
  }
}, { timestamps: true });

TreasuryRiskSchema.index({ tenantId: 1, status: 1, riskType: 1 });

TreasuryRiskSchema.set("toJSON", {
  transform: (_, ret) => {
    delete ret.__v;
    return ret;
  }
});

const TreasuryRiskModel = mongoose.model("treasury_risk", TreasuryRiskSchema);

export default TreasuryRiskModel;
