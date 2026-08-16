import mongoose from "mongoose";

// Enterprise Treasury Investment Management — Finance Module Part 18 (TMS).
// Tracks short-term & long-term cash investments, yield, maturity schedules, and counterparty banks.
// Tenant-scoped only — no branchId per Master Architecture rules.
const TreasuryInvestmentSchema = new mongoose.Schema({
  tenantId: {
    type: String,
    required: true,
    index: true
  },
  investmentId: {
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
  investmentType: {
    type: String,
    enum: ["FixedDeposit", "MoneyMarketFund", "GovernmentSecurity", "CorporateBond", "TreasuryBill", "Custom"],
    required: true,
    index: true
  },
  counterpartyBank: {
    type: String,
    required: true,
    index: true
  },
  currency: {
    type: String,
    required: true
  },
  principalAmount: {
    type: Number,
    required: true,
    min: 0
  },
  currentValue: {
    type: Number,
    required: true,
    min: 0
  },
  interestRate: {
    type: Number,
    required: true,
    min: 0 // percentage e.g. 5.25 for 5.25% p.a.
  },
  yieldPct: {
    type: Number,
    default: 0
  },
  startDate: {
    type: Date,
    required: true
  },
  maturityDate: {
    type: Date,
    required: true,
    index: true
  },
  status: {
    type: String,
    enum: ["Active", "Matured", "Liquidated", "Archived"],
    default: "Active",
    index: true
  },
  notes: {
    type: String,
    default: null
  },
  createdBy: {
    type: String,
    default: null
  },
  updatedBy: {
    type: String,
    default: null
  }
}, { timestamps: true });

TreasuryInvestmentSchema.index({ tenantId: 1, status: 1, maturityDate: 1 });

TreasuryInvestmentSchema.set("toJSON", {
  transform: (_, ret) => {
    delete ret.__v;
    return ret;
  }
});

const TreasuryInvestmentModel = mongoose.model("treasury_investment", TreasuryInvestmentSchema);

export default TreasuryInvestmentModel;
