import mongoose from "mongoose";

const DepartmentSchema = new mongoose.Schema({
  departmentKey: {
    type: String,
    required: true,
    unique: true,
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
  name: {
    type: String,
    required: true
  },
  description: {
    type: String,
    default: null
  },
  status: {
    type: String,
    enum: ["active", "inactive", "suspended", "deleted"],
    default: "active",
    index: true
  }
}, { timestamps: true });

DepartmentSchema.index({ tenantId: 1, branchId: 1, departmentKey: 1 });

const DepartmentModel = mongoose.model("department", DepartmentSchema);

export default DepartmentModel;
