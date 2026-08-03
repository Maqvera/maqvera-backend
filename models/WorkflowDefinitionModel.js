import mongoose from "mongoose";

const TransitionSchema = new mongoose.Schema({
  fromState: { type: String, required: true },
  action: { type: String, required: true },
  toState: { type: String, required: true },
  requiredPermission: { type: String, default: null },
  approvalRequired: { type: Boolean, default: false },
  approvalRole: { type: String, default: null },
  autoActions: [{ type: String }],
  guardConditions: [{ type: String }]
}, { _id: true });

const WorkflowDefinitionSchema = new mongoose.Schema({
  tenantId: { type: String, required: true, index: true },
  workflowName: { type: String, required: true },
  entityType: {
    type: String,
    enum: ["Booking", "Visa", "Payment", "Refund", "Task", "Employee", "Document", "Customer"],
    required: true,
    index: true
  },
  initialState: { type: String, required: true, default: "draft" },
  version: { type: Number, required: true, default: 1 },
  isActive: { type: Boolean, default: true, index: true },
  states: [{
    stateId: { type: String, required: true },
    label: { type: String, required: true },
    description: { type: String, default: null }
  }],
  transitions: [TransitionSchema],
  guardConditions: [{ type: String }],
  automationRules: [{ type: String }],
  slaPolicies: [{ type: mongoose.Schema.Types.Mixed }],
  escalationRules: [{ type: mongoose.Schema.Types.Mixed }],
  approvalPolicies: [{ type: mongoose.Schema.Types.Mixed }],
  isDefault: { type: Boolean, default: true }
}, { timestamps: true });

WorkflowDefinitionSchema.index({ tenantId: 1, entityType: 1, version: -1 });
WorkflowDefinitionSchema.index({ tenantId: 1, entityType: 1, version: 1 }, { unique: true });

const WorkflowDefinitionModel = mongoose.model("workflow_definition", WorkflowDefinitionSchema);

export default WorkflowDefinitionModel;
