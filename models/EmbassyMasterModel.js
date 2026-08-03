import mongoose from "mongoose";

const EmbassyMasterSchema = new mongoose.Schema({
  tenantId: { type: String, required: true, index: true },
  embassyId: { type: String, required: true },
  name: { type: String, required: true },
  processingCenterType: { type: String, enum: ["Embassy", "Consulate", "VAC", "Authorized_Partner", "Government_Portal"], required: true },
  countryId: { type: String, required: true, index: true },
  isActive: { type: Boolean, default: true, index: true }
}, { timestamps: true });

EmbassyMasterSchema.index({ tenantId: 1, embassyId: 1 }, { unique: true });
export default mongoose.model("embassy_master", EmbassyMasterSchema);
