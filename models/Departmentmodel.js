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
  // Enterprise Organisation Structure Platform (Improvement 4) — optional
  // hierarchy links (Company -> Branch -> Department). Left optional/
  // nullable deliberately: every pre-existing Department document (and
  // every tenant that never adopts the Organisation hierarchy at all)
  // keeps working unchanged with just tenantId, exactly as before this
  // platform existed. branchId is descriptive metadata only, same as
  // models/BranchModel.js itself — never used for access isolation.
  companyId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "org_company",
    default: null,
    index: true
  },
  branchId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "org_branch",
    default: null,
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
