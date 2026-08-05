import mongoose from "mongoose";

// Derived as a byproduct of the real airport sync, same reasoning as
// ReferenceCountryModel.
const ReferenceCitySchema = new mongoose.Schema({
  cityCode: { type: String, required: true, uppercase: true, trim: true },
  cityName: { type: String, required: true, trim: true },
  countryCode: { type: String, default: null, uppercase: true, trim: true },
  country: { type: String, default: null, trim: true },
  isActive: { type: Boolean, default: true, index: true },
  source: { type: String, enum: ["amadeus-live", "dynamic-sandbox"], required: true },
  lastSyncedAt: { type: Date, default: Date.now }
}, { timestamps: true });

ReferenceCitySchema.index({ cityCode: 1 }, { unique: true });

export default mongoose.model("reference_city", ReferenceCitySchema);
