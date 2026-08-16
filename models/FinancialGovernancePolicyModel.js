import mongoose from "mongoose";

// Enterprise Financial Governance & Compliance — Part 19.
// Centralized policy rules, versioning, dual authorization thresholds, and approval matrices.
// Tenant-scoped only — no branchId per Master Architecture rules.
const GovernanceRulesSchema = new mongoose.Schema({
  thresholdAmount: { type: Number, default: null }, // Amount above which policy applies (e.g. $100,000)
  requiresDualAuthorization: { type: Boolean, default: false },
  sodIncompatibleRoles: { type: [String], default: [] },
  sodIncompatibleActions: { type: [String], default: [] },
  allowedOperations: { type: [String], default: [] },
  fraudRiskThreshold: { type: Number, default: 75 }, // Risk score 0-100
  customConditions: { type: mongoose.Schema.Types.Mixed, default: {} }
}, { _id: false });

const FinancialGovernancePolicySchema = new mongoose.Schema({
  tenantId: {
    type: String,
    required: true,
    index: true
  },
  policyId: {
    type: String,
    required: true,
    unique: true,
    index: true
  },
  name: {
    type: String,
    required: true,
    trim: true,
    index: true
  },
  policyType: {
    type: String,
    enum: ["InternalControl", "SegregationOfDuties", "TaxCompliance", "RegulatoryCompliance", "FinancialRisk", "FraudPrevention", "Custom"],
    required: true,
    index: true
  },
  priority: {
    type: Number,
    required: true,
    default: 1,
    index: true
  },
  version: {
    type: Number,
    required: true,
    default: 1
  },
  status: {
    type: String,
    enum: ["Draft", "Active", "Suspended", "Archived"],
    default: "Active",
    index: true
  },
  effectiveDate: {
    type: Date,
    default: Date.now
  },
  expirationDate: {
    type: Date,
    default: null
  },
  owner: {
    type: String,
    default: "Chief Compliance Officer"
  },
  description: {
    type: String,
    default: null
  },
  rules: {
    type: GovernanceRulesSchema,
    default: () => ({})
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

FinancialGovernancePolicySchema.index({ tenantId: 1, status: 1, priority: 1 });
FinancialGovernancePolicySchema.index({ tenantId: 1, policyType: 1, status: 1 });

FinancialGovernancePolicySchema.set("toJSON", {
  transform: (_, ret) => {
    delete ret.__v;
    return ret;
  }
});

const FinancialGovernancePolicyModel = mongoose.model("financial_governance_policy", FinancialGovernancePolicySchema);

export default FinancialGovernancePolicyModel;
