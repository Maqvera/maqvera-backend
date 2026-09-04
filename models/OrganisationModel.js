import mongoose from "mongoose";

// Enterprise Organisation Structure Platform (Improvement 4) — the real
// business-group node between Tenant (the security boundary) and Legal
// Entity ("ABC Group" owning "ABC Builders LLC", "ABC Cement Pvt Ltd",
// "ABC Steel LLC" as separate legal entities). One tenant may own several
// organisations over time (e.g. a holding restructure), but every
// Organisation belongs to exactly one tenant — see utils/accessScope.js
// for why tenantId is the only field ever used to isolate access.
const OrganisationSchema = new mongoose.Schema({
  organisationCode: {
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
  name: {
    type: String,
    required: true
  },
  description: { type: String, default: null },
  industry: { type: String, default: null },
  // Config-driven (organisationStatuses) — Active, Inactive, Suspended, Closed.
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

OrganisationSchema.index({ tenantId: 1, status: 1 });

OrganisationSchema.set("toJSON", {
  transform: (_, ret) => {
    delete ret.__v;
    return ret;
  }
});

const OrganisationModel = mongoose.model("organisation", OrganisationSchema);

export default OrganisationModel;
