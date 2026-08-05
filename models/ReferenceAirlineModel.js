import mongoose from "mongoose";

const ReferenceAirlineSchema = new mongoose.Schema({
  iata: { type: String, required: true, uppercase: true, trim: true },
  icao: { type: String, default: null, uppercase: true, trim: true },
  airlineName: { type: String, required: true, trim: true },
  country: { type: String, default: null, trim: true },
  isActive: { type: Boolean, default: true, index: true },
  source: { type: String, enum: ["amadeus-live", "dynamic-sandbox"], required: true },
  lastSyncedAt: { type: Date, default: Date.now }
}, { timestamps: true });

ReferenceAirlineSchema.index({ iata: 1 }, { unique: true });

export default mongoose.model("reference_airline", ReferenceAirlineSchema);
