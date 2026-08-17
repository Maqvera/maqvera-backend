import mongoose from "mongoose";

// Enterprise Organisation Structure Platform (Improvement 4) — "Business
// Unit... Operational division. Business Unit is NOT a legal company."
// Example: Construction BU / Real Estate BU / Interior Design BU, all
// belonging to the same Legal Entity ("ABC Builders LLC"). organisationId
// is a denormalized read of legalEntityId's own parent, kept in sync only
// at create time (a legal entity never moves organisations in this pass).
const BusinessUnitSchema = new mongoose.Schema({
  businessUnitCode: {
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
  name: { type: String, required: true },
  description: { type: String, default: null },
  // Config-driven (businessUnitStatuses) — Active, Inactive, Closed.
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

BusinessUnitSchema.index({ tenantId: 1, legalEntityId: 1 });

BusinessUnitSchema.set("toJSON", {
  transform: (_, ret) => {
    delete ret.__v;
    return ret;
  }
});

const BusinessUnitModel = mongoose.model("business_unit", BusinessUnitSchema);

export default BusinessUnitModel;
