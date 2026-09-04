import mongoose from "mongoose";

// Enterprise Organisation Structure Platform (Improvement 4) — "Team...
// Optional. Payroll Team, Accounts Team, Audit Team." The leaf node under
// Department, above individual Employees.
const TeamSchema = new mongoose.Schema({
  teamCode: {
    type: String,
    required: true,
    unique: true,
    uppercase: true,
    trim: true
  },
  tenantId: {
    type: String,
    required: true,
    index: true
  },
  departmentId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "department",
    required: true,
    index: true
  },
  name: { type: String, required: true },
  description: { type: String, default: null },
  // Config-driven (teamStatuses) — Active, Inactive, Closed.
  status: { type: String, required: true, index: true },
  closedAt: { type: Date, default: null },
  closedBy: { type: String, default: null },
  timeline: [{
    event: { type: String, required: true },
    description: { type: String, default: null },
    performedBy: { type: String, default: null },
    performedAt: { type: Date, default: Date.now }
  }],
  createdBy: { type: String, default: null },
  updatedBy: { type: String, default: null }
}, { timestamps: true, optimisticConcurrency: true });

TeamSchema.index({ tenantId: 1, departmentId: 1 });

TeamSchema.set("toJSON", {
  transform: (_, ret) => {
    delete ret.__v;
    return ret;
  }
});

const TeamModel = mongoose.model("team", TeamSchema);

export default TeamModel;
