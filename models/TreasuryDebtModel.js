import mongoose from "mongoose";

// Enterprise Treasury Debt & Loan Management — Finance Module Part 18 (TMS).
// Tracks credit facilities, term loans, repayment schedules, interest commitments, and covenants.
// Tenant-scoped only — no branchId per Master Architecture rules.
const CovenantSchema = new mongoose.Schema({
  covenantName: { type: String, required: true },
  metric: { type: String, required: true }, // e.g. "DebtToEquity", "InterestCoverageRatio"
  targetValue: { type: Number, required: true },
  currentValue: { type: Number, default: 0 },
  compliant: { type: Boolean, default: true }
}, { _id: false });

const TreasuryDebtSchema = new mongoose.Schema({
  tenantId: {
    type: String,
    required: true,
    index: true
  },
  debtId: {
    type: String,
    required: true,
    unique: true,
    index: true
  },
  facilityName: {
    type: String,
    required: true,
    index: true
  },
  debtType: {
    type: String,
    enum: ["TermLoan", "RevolvingCreditFacility", "BankOverdraft", "CorporateBond", "SyndicatedLoan", "Custom"],
    required: true,
    index: true
  },
  lender: {
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
  outstandingBalance: {
    type: Number,
    required: true,
    min: 0
  },
  interestRate: {
    type: Number,
    required: true,
    min: 0 // percentage e.g. 6.5 for 6.5% p.a.
  },
  interestType: {
    type: String,
    enum: ["Fixed", "Floating"],
    default: "Fixed"
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
  repaymentFrequency: {
    type: String,
    enum: ["Monthly", "Quarterly", "Annually", "Bullet"],
    default: "Monthly"
  },
  nextPaymentDate: {
    type: Date,
    default: null
  },
  nextPaymentAmount: {
    type: Number,
    default: 0
  },
  covenants: {
    type: [CovenantSchema],
    default: []
  },
  status: {
    type: String,
    enum: ["Active", "Repaid", "Defaulted", "Archived"],
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

TreasuryDebtSchema.index({ tenantId: 1, status: 1, maturityDate: 1 });

TreasuryDebtSchema.set("toJSON", {
  transform: (_, ret) => {
    delete ret.__v;
    return ret;
  }
});

const TreasuryDebtModel = mongoose.model("treasury_debt", TreasuryDebtSchema);

export default TreasuryDebtModel;
