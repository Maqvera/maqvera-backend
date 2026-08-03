import mongoose from "mongoose";

const EmploymentHistorySchema = new mongoose.Schema({
  employeeId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "employee",
    required: true,
    index: true
  },
  tenantId: {
    type: String,
    required: true,
    index: true
  },
  branchId: {
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
  roleIds: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: "role"
  }],
  changeType: {
    type: String,
    enum: ["joined", "transferred", "department_changed", "role_changed", "promoted", "suspended", "reactivated", "archived"],
    required: true
  },
  fromDate: {
    type: Date,
    default: Date.now
  },
  toDate: {
    type: Date,
    default: null
  },
  notes: {
    type: String,
    default: null
  }
}, { timestamps: true });

const EmploymentHistoryModel = mongoose.model("employment_history", EmploymentHistorySchema);

export default EmploymentHistoryModel;
