import mongoose from "mongoose";

const HistorySchema = new mongoose.Schema({
  fromState: { type: String, required: true },
  toState: { type: String, required: true },
  action: { type: String, required: true },
  performedBy: { type: String, default: null },
  performedByName: { type: String, default: "Staff" },
  timestamp: { type: Date, default: Date.now },
  comments: { type: String, default: null },
  approvalDetails: { type: mongoose.Schema.Types.Mixed, default: null }
}, { _id: true });

const PendingApprovalSchema = new mongoose.Schema({
  action: { type: String, required: true },
  targetState: { type: String, required: true },
  requestedBy: { type: String, required: true },
  requestedByName: { type: String, default: "Staff" },
  requiredRole: { type: String, default: "admin" },
  status: { type: String, enum: ["pending", "approved", "rejected"], default: "pending" },
  approvedBy: { type: String, default: null },
  approvedByName: { type: String, default: null },
  approvedAt: { type: Date, default: null },
  comments: { type: String, default: null }
}, { _id: true });

const WorkflowInstanceSchema = new mongoose.Schema({
  tenantId: { type: String, required: true, index: true },
  entityType: {
    type: String,
    enum: ["Booking", "Visa", "Payment", "Refund", "Task", "Employee", "Document", "Customer"],
    required: true,
    index: true
  },
  entityId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
  workflowDefinitionId: { type: mongoose.Schema.Types.ObjectId, ref: "workflow_definition", default: null },
  currentState: { type: String, required: true, default: "draft", index: true },
  previousState: { type: String, default: null },
  completedSteps: [{ type: String }],
  pendingApprovals: [PendingApprovalSchema],
  history: [HistorySchema],
  status: { type: String, enum: ["active", "completed", "cancelled"], default: "active", index: true }
}, { timestamps: true });

WorkflowInstanceSchema.index({ tenantId: 1, entityType: 1, entityId: 1 }, { unique: true });

const WorkflowInstanceModel = mongoose.model("workflow_instance", WorkflowInstanceSchema);

export default WorkflowInstanceModel;
