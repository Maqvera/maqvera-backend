import mongoose from "mongoose";

// Strategic Scenario Planning — Finance Module Part 17.
// What-if evaluation engine against baselines.
// Tenant-scoped only — no branchId per Master Architecture rules.
const ScenarioAssumptionsSchema = new mongoose.Schema({
  revenueMultiplier: { type: Number, default: 1.0 }, // e.g. 1.15 for +15% revenue
  expenseMultiplier: { type: Number, default: 1.0 }, // e.g. 0.90 for -10% cost reduction
  inflationRate: { type: Number, default: 0 },       // e.g. 3.5 for 3.5% inflation
  headcountGrowthPct: { type: Number, default: 0 },  // e.g. 5.0 for +5% headcount cost
  customParameters: { type: mongoose.Schema.Types.Mixed, default: {} }
}, { _id: false });

const ProjectedOutcomeSchema = new mongoose.Schema({
  baselineRevenue: { type: Number, default: 0 },
  projectedRevenue: { type: Number, default: 0 },
  baselineExpense: { type: Number, default: 0 },
  projectedExpense: { type: Number, default: 0 },
  baselineProfit: { type: Number, default: 0 },
  projectedProfit: { type: Number, default: 0 },
  varianceToBaseline: { type: Number, default: 0 },
  varianceToBaselinePct: { type: Number, default: 0 }
}, { _id: false });

const ScenarioSchema = new mongoose.Schema({
  tenantId: {
    type: String,
    required: true,
    index: true
  },
  scenarioId: {
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
  scenarioType: {
    type: String,
    enum: ["BestCase", "ExpectedCase", "WorstCase", "GrowthScenario", "CostReductionScenario", "Custom"],
    required: true,
    index: true
  },
  baseBudgetId: {
    type: String,
    default: null,
    index: true
  },
  baseForecastId: {
    type: String,
    default: null,
    index: true
  },
  fiscalYear: {
    type: String,
    required: true,
    index: true
  },
  currency: {
    type: String,
    required: true
  },
  assumptions: {
    type: ScenarioAssumptionsSchema,
    default: () => ({})
  },
  projectedOutcome: {
    type: ProjectedOutcomeSchema,
    default: () => ({})
  },
  description: {
    type: String,
    default: null
  },
  evaluatedAt: {
    type: Date,
    default: null
  },
  evaluatedBy: {
    type: String,
    default: null
  }
}, { timestamps: true });

ScenarioSchema.index({ tenantId: 1, scenarioType: 1, fiscalYear: 1 });

ScenarioSchema.set("toJSON", {
  transform: (_, ret) => {
    delete ret.__v;
    return ret;
  }
});

const ScenarioModel = mongoose.model("financial_scenario", ScenarioSchema);

export default ScenarioModel;
