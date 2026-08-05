import mongoose from "mongoose";

// EXT-013 §10/§16 honest gap: Amadeus's Self-Service catalog has no real
// standalone "aircraft type reference data" endpoint to sync from (unlike
// airports/airlines, which have real Airport & City Search / Airline Code
// Lookup APIs). Seeded from this codebase's existing curated IATA
// aircraft-equipment-code dictionary (`AmadeusAdapter.AIRCRAFT_NAME_MAP`,
// already relied on live for EXT-008/012 normalization) rather than a
// fabricated live call to an endpoint that doesn't exist — source is
// always "static-reference", never "amadeus-live".
const ReferenceAircraftSchema = new mongoose.Schema({
  code: { type: String, required: true, uppercase: true, trim: true },
  name: { type: String, required: true, trim: true },
  manufacturer: { type: String, default: null, trim: true },
  isActive: { type: Boolean, default: true, index: true },
  source: { type: String, enum: ["static-reference"], required: true, default: "static-reference" },
  lastSyncedAt: { type: Date, default: Date.now }
}, { timestamps: true });

ReferenceAircraftSchema.index({ code: 1 }, { unique: true });

export default mongoose.model("reference_aircraft", ReferenceAircraftSchema);
