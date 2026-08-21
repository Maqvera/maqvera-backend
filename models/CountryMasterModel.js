import mongoose from "mongoose";

const CountryMasterSchema = new mongoose.Schema({
  tenantId: { type: String, required: true, index: true },
  countryId: { type: String, required: true },
  code: { type: String, required: true, uppercase: true, trim: true },
  name: { type: String, required: true, trim: true },
  // Visa Module PRD §7 "Admin create kar sake: Country Name, Currency,
  // Processing Time, Active/Inactive". This model was already the real
  // country master both Customer (address/nationality validation) and Visa
  // (VisaService.resolveCountry, VisaRequirementService's requirement
  // profiles) validate against — it just had no currency/processing-time
  // fields and no write endpoint until now.
  defaultCurrency: { type: String, default: "USD" },
  defaultProcessingDays: { type: Number, default: 7 },
  isActive: { type: Boolean, default: true, index: true }
}, { timestamps: true });

CountryMasterSchema.index({ tenantId: 1, countryId: 1 }, { unique: true });
CountryMasterSchema.index({ tenantId: 1, code: 1 }, { unique: true });
export default mongoose.model("country_master", CountryMasterSchema);
