import mongoose from "mongoose";

// Enterprise Organisation Structure Platform (Improvement 4) — "Legal
// Entity... registered company recognised by government. Each has
// different tax number, legal registration, financial statements, audit,
// statutory reports." This is the real financial-statement boundary
// (distinct from Tenant, the access/security boundary, and from
// Organisation, the commercial grouping above it). Every Legal Entity
// belongs to exactly one Organisation, and every Organisation belongs to
// exactly one Tenant.
const LegalEntitySchema = new mongoose.Schema({
  legalEntityCode: {
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
  name: { type: String, required: true },
  registrationNumber: { type: String, default: null },
  taxNumber: { type: String, default: null },
  country: { type: String, default: null },
  // Base currency this legal entity's own financial statements are
  // reported in — deliberately independent of any other legal entity
  // under the same organisation (real multi-country consolidation case).
  reportingCurrency: { type: String, default: null },
  // Config-driven (legalEntityStatuses) — Pending, Active, Inactive,
  // Suspended, Closed. A legal entity starts Pending until a real
  // registrationNumber + taxNumber are on file, then an explicit
  // activate step (LegalEntityActivated event) moves it to Active.
  status: { type: String, required: true, index: true },
  activatedAt: { type: Date, default: null },
  activatedBy: { type: String, default: null },
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

LegalEntitySchema.index({ tenantId: 1, organisationId: 1 });

LegalEntitySchema.set("toJSON", {
  transform: (_, ret) => {
    delete ret.__v;
    return ret;
  }
});

const LegalEntityModel = mongoose.model("legal_entity", LegalEntitySchema);

export default LegalEntityModel;
