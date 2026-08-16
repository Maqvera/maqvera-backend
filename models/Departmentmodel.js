import mongoose from "mongoose";

const DepartmentSchema = new mongoose.Schema({
  departmentKey: {
    type: String,
    required: true,
    index: true
  },
  tenantId: {
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

DepartmentSchema.index({ tenantId: 1, departmentKey: 1 }, { unique: true });

const DepartmentModel = mongoose.model("department", DepartmentSchema);

export default DepartmentModel;
