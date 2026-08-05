import mongoose from "mongoose";

// EXT-013 — global aviation reference data, not tenant-owned (every tenant
// reads the same shared airport master data; there is no per-tenant
// airport list to isolate, unlike CountryMasterModel's tenant-editable
// visa-country list, which is a different domain and deliberately left
// untouched here).
const ReferenceAirportSchema = new mongoose.Schema({
  iata: { type: String, required: true, uppercase: true, trim: true },
  icao: { type: String, default: null, uppercase: true, trim: true },
  airportName: { type: String, required: true, trim: true },
  city: { type: String, default: null, trim: true },
  cityCode: { type: String, default: null, uppercase: true, trim: true },
  country: { type: String, default: null, trim: true },
  countryCode: { type: String, default: null, uppercase: true, trim: true },
  latitude: { type: Number, default: null },
  longitude: { type: Number, default: null },
  // Amadeus's real Airport & City Search response gives a UTC offset
  // string (e.g. "+05:00") when present, not an IANA zone name — stored
  // as-is rather than guessed into "Asia/Karachi"-style identifiers.
  timezone: { type: String, default: null },
  // EXT-014 §7 "internationalOnly" filter. Amadeus's normalized Airport &
  // City Search response has no confirmed real field distinguishing
  // domestic-only airfields from international airports — rather than
  // guess a classification per airport, every synced record defaults to
  // `true` (honest gap, same category as EXT-013's timezone/operatingDays
  // notes). The filter itself is real and functions correctly the moment
  // this field is ever populated with a genuine distinguishing signal.
  isInternational: { type: Boolean, default: true, index: true },
  isActive: { type: Boolean, default: true, index: true },
  source: { type: String, enum: ["amadeus-live", "dynamic-sandbox"], required: true },
  lastSyncedAt: { type: Date, default: Date.now }
}, { timestamps: true });

ReferenceAirportSchema.index({ iata: 1 }, { unique: true });
ReferenceAirportSchema.index({ cityCode: 1 });
ReferenceAirportSchema.index({ countryCode: 1 });
// EXT-014 §15 "GIN Full Text Index" — this codebase is MongoDB, not
// PostgreSQL (see EXT-013's honest architectural-adaptation note), so the
// real equivalent is a Mongo text index. It's used only as a cheap
// candidate-narrowing pre-filter at scale; actual ranking (prefix/contains/
// phonetic/fuzzy/exact tiers per §13) is computed in
// ReferenceDataService.searchAirports, since Mongo's $text has no prefix or
// fuzzy-distance support of its own — there is no direct Mongo equivalent
// to PostgreSQL's pg_trgm trigram similarity.
ReferenceAirportSchema.index({ airportName: "text", city: "text", country: "text" });

export default mongoose.model("reference_airport", ReferenceAirportSchema);
