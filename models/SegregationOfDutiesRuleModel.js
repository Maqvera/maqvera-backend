import mongoose from "mongoose";

// Enterprise Segregation of Duties (SoD) — Part 19.
// Enforces incompatible action/role pairs (e.g. Creator vs Approver, Vendor Creator vs Payment Execution).
// Tenant-scoped only — no branchId per Master Architecture rules.
const SegregationOfDutiesRuleSchema = new mongoose.Schema({
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
  description: {
    type: String,
    default: null
  },
  firstAction: {
    type: String,
    required: true,
    index: true // e.g. "CreateVendor", "CreateJournal", "CreatePaymentProposal"
  },
  secondAction: {
    type: String,
    required: true,
    index: true // e.g. "ApproveVendorPayment", "PostJournal", "ExecutePayment"
  },
  riskLevel: {
    type: String,
    enum: ["Low", "Medium", "High", "Critical"],
    default: "High",
    index: true
  },
  status: {
    type: String,
    enum: ["Active", "Inactive"],
    default: "Active",
    index: true
  },
  mitigationControl: {
    type: String,
    default: null
  },
  createdBy: {
    type: String,
    default: null
  }
}, { timestamps: true });

SegregationOfDutiesRuleSchema.index({ tenantId: 1, status: 1, firstAction: 1, secondAction: 1 });

SegregationOfDutiesRuleSchema.set("toJSON", {
  transform: (_, ret) => {
    delete ret.__v;
    return ret;
  }
});

const SegregationOfDutiesRuleModel = mongoose.model("segregation_of_duties_rule", SegregationOfDutiesRuleSchema);

export default SegregationOfDutiesRuleModel;
