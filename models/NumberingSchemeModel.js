import mongoose from "mongoose";

// Enterprise Identity & Global Resource ID Platform (Improvement 5) — the
// real, admin-configurable FORMAT for one resourceType's document numbers.
// "Company wants INV-2027-001. Allowed. Another wants SALES-0001. Allowed.
// Another wants DXB-INV-2027-00001. Allowed." — every one of those is a
// real combination of the flags below, not a hardcoded format string.
//
// companyId/branchId here are the same descriptive, non-isolating
// references as models/CompanyModel.js/BranchModel.js (Improvement 4) —
// "Support Company/Branch Specific Sequences" means a tenant MAY run a
// separate numbering sequence per company/branch, never that branchId
// gates access to anything.
const NumberingSchemeSchema = new mongoose.Schema({
  tenantId: { type: String, required: true, index: true },
  // Free string, not an enum — see utils/numberingConfig.js's own doc
  // comment on why resourceType is deliberately open-ended.
  resourceType: { type: String, required: true, trim: true },
  companyId: { type: mongoose.Schema.Types.ObjectId, ref: "org_company", default: null, index: true },
  branchId: { type: mongoose.Schema.Types.ObjectId, ref: "org_branch", default: null, index: true },

  prefix: { type: String, required: true, trim: true },
  separator: { type: String, default: "-" },
  includeYear: { type: Boolean, default: true },
  includeCompany: { type: Boolean, default: false },
  includeBranch: { type: Boolean, default: false },
  sequenceLength: { type: Number, default: 6, min: 1, max: 12 },
  fiscalYearStartMonth: { type: Number, default: 1, min: 1, max: 12 },
  // "Sequences Must Be Gap-Aware (Configurable)" — true (default) means a
  // reserved-but-never-registered number is simply left as a permanent
  // gap (the honest, standard accounting-document behavior); false opts
  // into best-effort reuse via NumberGeneratorService.rollbackSequence,
  // which only ever compare-and-decrements (never blindly rewinds), so it
  // can never hand out a number that's already been reused underneath it.
  allowGaps: { type: Boolean, default: true },
  // The scheme used when no company/branch-specific scheme matches a
  // generate() call for this resourceType. Exactly one default per
  // (tenantId, resourceType) — enforced in NumberGeneratorService, not by
  // a partial unique index (Mongo can't express "unique only when true"
  // without a partial-filter index per resourceType value, which would
  // need to be declared per value; a service-level check is simpler and
  // just as real).
  isDefault: { type: Boolean, default: false },

  status: { type: String, required: true, index: true },
  timeline: [{
    event: { type: String, required: true },
    description: { type: String, default: null },
    performedBy: { type: String, default: null },
    performedAt: { type: Date, default: Date.now }
  }],
  createdBy: { type: String, default: null },
  updatedBy: { type: String, default: null }
}, { timestamps: true, optimisticConcurrency: true });

NumberingSchemeSchema.index({ tenantId: 1, resourceType: 1, companyId: 1, branchId: 1 }, { unique: true });

NumberingSchemeSchema.set("toJSON", {
  transform: (_, ret) => {
    delete ret.__v;
    return ret;
  }
});

const NumberingSchemeModel = mongoose.model("numbering_scheme", NumberingSchemeSchema);

export default NumberingSchemeModel;
