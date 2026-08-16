import mongoose from "mongoose";

// Enterprise Financial Fraud Detection Rules — Part 19.
// Rules for detecting duplicate payments, suspicious amounts, velocity spikes, and unusual patterns.
// Tenant-scoped only — no branchId per Master Architecture rules.
const FinancialFraudRuleSchema = new mongoose.Schema({
  tenantId: {
    type: String,
    required: true,
    index: true
  },
  ruleId: {
    type: String,
    required: true,
    unique: true,
    index: true
  },
  ruleName: {
    type: String,
    required: true,
    trim: true,
    index: true
  },
  checkType: {
    type: String,
    enum: ["DuplicatePayment", "UnusualAmount", "ApprovalVelocity", "HighRiskVendor", "OffHoursTransaction", "Custom"],
    required: true,
    index: true
  },
  riskSeverity: {
    type: String,
    enum: ["Low", "Medium", "High", "Critical"],
    default: "High",
    index: true
  },
  parameters: {
    type: mongoose.Schema.Types.Mixed,
    default: {}
  },
  status: {
    type: String,
    enum: ["Active", "Inactive"],
    default: "Active",
    index: true
  },
  createdBy: {
    type: String,
    default: null
  }
}, { timestamps: true });

FinancialFraudRuleSchema.index({ tenantId: 1, status: 1, checkType: 1 });

FinancialFraudRuleSchema.set("toJSON", {
  transform: (_, ret) => {
    delete ret.__v;
    return ret;
  }
});

const FinancialFraudRuleModel = mongoose.model("financial_fraud_rule", FinancialFraudRuleSchema);

export default FinancialFraudRuleModel;
