import mongoose from "mongoose";

// Enterprise Organisation Structure Platform (Improvement 4) — "Branch...
// Physical office." Deliberately rebuilt as a DESCRIPTIVE/ORGANISATIONAL
// hierarchy node only (a Company's physical office), never as a
// data-isolation boundary. This codebase already removed branch-level
// ACCESS isolation once (docs/06-external-integrations/
// 03-final-architecture-no-branches-rbac.md, scripts/migrateRemoveBranchId.js)
// and that removal stands: utils/accessScope.js's getAccessScope() must
// keep returning `{ tenantId }` only — branchId is NEVER added to it or to
// any hand-rolled access-control filter. This model exists purely so the
// Organisation hierarchy (Company -> Branch -> Department) has a real
// backing record to point at.
const BranchSchema = new mongoose.Schema({
  branchCode: {
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
  companyId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "org_company",
    required: true,
    index: true
  },
  name: { type: String, required: true },
  address: {
    line1: { type: String, default: null },
    city: { type: String, default: null },
    country: { type: String, default: null },
    postalCode: { type: String, default: null }
  },
  // Config-driven (branchStatuses) — Active, Inactive, Closed.
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

BranchSchema.index({ tenantId: 1, companyId: 1 });

BranchSchema.set("toJSON", {
  transform: (_, ret) => {
    delete ret.__v;
    return ret;
  }
});

const BranchModel = mongoose.model("org_branch", BranchSchema);

export default BranchModel;
