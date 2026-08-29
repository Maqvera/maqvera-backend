import mongoose from "mongoose";

const EmbassyMasterSchema = new mongoose.Schema({
  tenantId: { type: String, required: true, index: true },
  embassyId: { type: String, required: true },
  name: { type: String, required: true },
  processingCenterType: { type: String, enum: ["Embassy", "Consulate", "VAC", "Authorized_Partner", "Government_Portal"], required: true },
  countryId: { type: String, required: true, index: true },
  isActive: { type: Boolean, default: true, index: true },
  // PRD "CRM Feature Map by Phase" Phase 4 module 40 (Emergency Support —
  // embassy/consulate contact directory). Extends this existing model
  // rather than a second, parallel one, per that task's own instruction —
  // EmbassyMasterModel already holds embassy identity for visa-submission
  // routing (services/EmbassyProcessingService.js); these are purely
  // additive contact fields, optional so no existing row/consumer is affected.
  city: { type: String, default: null },
  phone: { type: String, default: null },
  email: { type: String, default: null },
  address: { type: String, default: null },
  emergencyContactPhone: { type: String, default: null }
}, { timestamps: true });

EmbassyMasterSchema.index({ tenantId: 1, embassyId: 1 }, { unique: true });
export default mongoose.model("embassy_master", EmbassyMasterSchema);
