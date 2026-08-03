import mongoose from "mongoose";

const CountryMasterSchema = new mongoose.Schema({
  tenantId: { type: String, required: true, index: true },
  countryId: { type: String, required: true },
  code: { type: String, required: true, uppercase: true, trim: true },
  name: { type: String, required: true, trim: true },
  isActive: { type: Boolean, default: true, index: true }
}, { timestamps: true });

CountryMasterSchema.index({ tenantId: 1, countryId: 1 }, { unique: true });
CountryMasterSchema.index({ tenantId: 1, code: 1 }, { unique: true });
export default mongoose.model("country_master", CountryMasterSchema);
