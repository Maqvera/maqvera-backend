import mongoose from "mongoose";

// Enterprise Governance Evaluation Record — Part 19.
// Permanent decision log of governance policy evaluation, risk scoring, SoD checks, and fraud screening.
// Tenant-scoped only — no branchId per Master Architecture rules.
const EvaluatedPolicySchema = new mongoose.Schema({
  policyId: { type: String, required: true },
  name: { type: String, required: true },
  passed: { type: Boolean, required: true },
  reason: { type: String, default: null }
}, { _id: false });

const SoDViolationSchema = new mongoose.Schema({
  ruleId: { type: String, required: true },
  ruleName: { type: String, required: true },
  firstAction: { type: String, required: true },
  secondAction: { type: String, required: true },
  user1: { type: String, default: null },
  user2: { type: String, default: null }
}, { _id: false });

const FraudFlagSchema = new mongoose.Schema({
  checkName: { type: String, required: true },
  severity: { type: String, required: true },
  details: { type: String, default: null }
}, { _id: false });

const GovernanceEvaluationSchema = new mongoose.Schema({
  tenantId: {
    type: String,
    required: true,
    index: true
  },
  evaluationId: {
    type: String,
    required: true,
    unique: true,
    index: true
  },
  transactionId: {
    type: String,
    required: true,
    index: true
  },
  operation: {
    type: String,
    required: true,
    index: true // e.g. "VendorPayment", "JournalPosting", "AssetWriteOff"
  },
  amount: {
    type: Number,
    default: 0
  },
  creatorId: {
    type: String,
    default: null
  },
  approverId: {
    type: String,
    default: null
  },
  decision: {
    type: String,
    enum: ["Approved", "Rejected", "FlaggedForReview", "DualApprovalRequired"],
    required: true,
    index: true
  },
  riskScore: {
    type: Number,
    default: 0 // 0 to 100
  },
  evaluatedPolicies: {
    type: [EvaluatedPolicySchema],
    default: []
  },
  sodViolations: {
    type: [SoDViolationSchema],
    default: []
  },
  fraudFlags: {
    type: [FraudFlagSchema],
    default: []
  },
  evidenceHash: {
    type: String,
    default: null
  },
  evaluatedAt: {
    type: Date,
    default: Date.now,
    index: true
  },
  evaluatedBy: {
    type: String,
    default: null
  }
}, { timestamps: true });

GovernanceEvaluationSchema.index({ tenantId: 1, transactionId: 1 });
GovernanceEvaluationSchema.index({ tenantId: 1, decision: 1, evaluatedAt: -1 });

GovernanceEvaluationSchema.set("toJSON", {
  transform: (_, ret) => {
    delete ret.__v;
    return ret;
  }
});

const GovernanceEvaluationModel = mongoose.model("governance_evaluation", GovernanceEvaluationSchema);

export default GovernanceEvaluationModel;
