import mongoose from "mongoose";

// Enterprise Organisation Structure Platform (Improvement 4) — "Company...
// Operational company inside ERP. Usually belongs to one Legal Entity."
// NOT to be confused with this codebase's own pre-existing "Company =
// Tenant" shorthand (docs/06-external-integrations/
// 03-final-architecture-no-branches-rbac.md, utils/accessScope.js) — that
// shorthand describes the TENANT as a whole (the security boundary); this
// model is a new, lower-level operational node BELOW Tenant, for a tenant
// that runs more than one operating company under the same legal entity.
// Tenant remains the only access-isolation boundary either way.
const CompanySchema = new mongoose.Schema({
  companyCode: {
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
  organisationId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "organisation",
    required: true,
    index: true
  },
  legalEntityId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "legal_entity",
    required: true,
    index: true
  },
  // Optional — "Construction BU owns ABC Builders Karachi" is a real,
  // common case, but a company doesn't have to be tagged to one business
  // unit to exist.
  businessUnitId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "business_unit",
    default: null,
    index: true
  },
  name: { type: String, required: true },
  registrationNumber: { type: String, default: null },
  taxNumber: { type: String, default: null },
  country: { type: String, default: null },
  currency: { type: String, default: null },
  // Config-driven (companyStatuses) — Active, Inactive, Suspended, Closed.
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

CompanySchema.index({ tenantId: 1, legalEntityId: 1 });

CompanySchema.set("toJSON", {
  transform: (_, ret) => {
    delete ret.__v;
    return ret;
  }
});

const CompanyModel = mongoose.model("org_company", CompanySchema);

export default CompanyModel;
