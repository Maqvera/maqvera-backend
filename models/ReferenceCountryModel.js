import mongoose from "mongoose";

// EXT-013's own global aviation-reference country list — deliberately
// separate from CountryMasterModel (tenant-scoped, visa-compliance-owned,
// manually tenant-editable). This collection is derived automatically as a
// byproduct of the real airport sync (each Amadeus airport record's own
// address.countryCode/countryName), never manually edited, and shared
// across all tenants — merging the two would conflate two different
// domains that this codebase's architecture keeps separate by design.
const ReferenceCountrySchema = new mongoose.Schema({
  code: { type: String, required: true, uppercase: true, trim: true },
  name: { type: String, required: true, trim: true },
  isActive: { type: Boolean, default: true, index: true },
  source: { type: String, enum: ["amadeus-live", "dynamic-sandbox"], required: true },
  lastSyncedAt: { type: Date, default: Date.now }
}, { timestamps: true });

ReferenceCountrySchema.index({ code: 1 }, { unique: true });

export default mongoose.model("reference_country", ReferenceCountrySchema);
