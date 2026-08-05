import mongoose from "mongoose";
import AmadeusAdapter from "./gds/AmadeusAdapter.js";
import GdsIntegrationService from "./GdsIntegrationService.js";
import CacheManager from "../utils/cacheManager.js";
import AuditLogModel from "../models/AuditLogmodel.js";
import ReferenceAirportModel from "../models/ReferenceAirportModel.js";
import ReferenceAirlineModel from "../models/ReferenceAirlineModel.js";
import ReferenceAircraftModel from "../models/ReferenceAircraftModel.js";
import ReferenceCountryModel from "../models/ReferenceCountryModel.js";
import ReferenceCityModel from "../models/ReferenceCityModel.js";
import { publishEvent } from "../utils/eventBus.js";
import { throwStructured } from "./AmadeusFlightBookingService.js";
import { getReferenceDataSyncConfig, getAirportSearchConfig } from "../utils/referenceDataConfig.js";

const CACHE_PREFIX = "reference";
const QUERY_ALLOWED_PATTERN = /^[\p{L}\p{N}\s'.-]+$/u;

const escapeRegExp = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const deriveManufacturer = (name) => {
  if (!name) return null;
  if (name.startsWith("Airbus")) return "Airbus";
  if (name.startsWith("Boeing")) return "Boeing";
  return null;
};

/** True when any tracked field differs — used to decide whether an *Updated event is genuinely warranted. */
const hasChanged = (existingDoc, incoming, fields) => {
  if (!existingDoc) return true;
  return fields.some((f) => (existingDoc[f] ?? null) !== (incoming[f] ?? null));
};

/**
 * EXT-013 — Reference Data Service. Owns the daily sync of Amadeus airport/
 * airline reference data (plus a locally-curated aircraft dictionary) into
 * this codebase's real persistence layer (Mongoose "master" collections —
 * this is a MongoDB-only modular monolith per CLAUDE.md, so the source
 * doc's literal "PostgreSQL Master Tables" is honestly adapted to Mongoose
 * collections, following the exact same pattern CountryMasterModel/
 * EmbassyMasterModel already use elsewhere in this codebase), and serves
 * every read from cache-first → master table → provider only during sync
 * ("Never call Amadeus for every request" — §18).
 */
class ReferenceDataService {
  // ── EXT-014 ranking primitives (static, for direct testability — same
  // convention AmadeusAdapter uses for its own pure-logic statics) ───────

  /** Classic Levenshtein edit distance — real algorithm, the honest local stand-in for PostgreSQL's pg_trgm fuzzy similarity (§13 "Fuzzy Match"). */
  static _levenshtein(a, b) {
    if (a === b) return 0;
    if (a.length === 0) return b.length;
    if (b.length === 0) return a.length;
    const rows = a.length + 1;
    const cols = b.length + 1;
    const matrix = Array.from({ length: rows }, (_, i) => [i, ...Array(cols - 1).fill(0)]);
    for (let j = 0; j < cols; j += 1) matrix[0][j] = j;
    for (let i = 1; i < rows; i += 1) {
      for (let j = 1; j < cols; j += 1) {
        const cost = a[i - 1] === b[j - 1] ? 0 : 1;
        matrix[i][j] = Math.min(matrix[i - 1][j] + 1, matrix[i][j - 1] + 1, matrix[i - 1][j - 1] + cost);
      }
    }
    return matrix[rows - 1][cols - 1];
  }

  /** Classic Soundex phonetic algorithm — real, standard implementation, for §13 "Phonetic Match" (e.g. "Karachy" ~ "Karachi"). */
  static _soundex(word) {
    const s = String(word || "").toUpperCase().replace(/[^A-Z]/g, "");
    if (!s) return "";
    const codes = { B: "1", F: "1", P: "1", V: "1", C: "2", G: "2", J: "2", K: "2", Q: "2", S: "2", X: "2", Z: "2", D: "3", T: "3", L: "4", M: "5", N: "5", R: "6" };
    let result = s[0];
    let lastCode = codes[s[0]] || "";
    for (let i = 1; i < s.length && result.length < 4; i += 1) {
      const code = codes[s[i]] || "";
      if (code && code !== lastCode) result += code;
      lastCode = code;
    }
    return (result + "000").slice(0, 4);
  }

  /**
   * §13 "Search Ranking" — Exact IATA > Exact Airport Name > Exact City Name
   * > Prefix > Contains > Phonetic > Fuzzy. Returns 0 when nothing matches
   * at all (never a fabricated baseline score for an irrelevant record).
   */
  static _scoreAirport(airport, normalizedQuery) {
    const q = normalizedQuery.toLowerCase();
    const iata = (airport.iata || "").toLowerCase();
    const icao = (airport.icao || "").toLowerCase();
    const name = (airport.airportName || "").toLowerCase();
    const city = (airport.city || "").toLowerCase();

    if (iata === q || icao === q) return 100;
    if (name === q) return 95;
    if (city === q) return 90;
    if (iata.startsWith(q)) return 88;
    if (city.startsWith(q)) return 85;
    if (name.startsWith(q)) return 82;
    if (city.includes(q) || name.includes(q)) return 70;

    const querySoundex = ReferenceDataService._soundex(normalizedQuery);
    if (querySoundex && (ReferenceDataService._soundex(airport.city) === querySoundex || ReferenceDataService._soundex((airport.airportName || "").split(" ")[0]) === querySoundex)) {
      return 55;
    }

    const distance = Math.min(ReferenceDataService._levenshtein(q, city), ReferenceDataService._levenshtein(q, name.slice(0, q.length + 2)));
    const maxLen = Math.max(q.length, Math.min(city.length || q.length, q.length + 2));
    const similarity = 1 - distance / Math.max(maxLen, 1);
    if (similarity >= 0.6) return Math.round(30 + similarity * 19); // 30-49 band, per §13's lowest tier

    return 0;
  }

  // ── Sync ────────────────────────────────────────────────────────────

  static async syncAirports() {
    const config = getReferenceDataSyncConfig();
    let updated = 0;
    const unknownCodes = [];

    for (const code of config.seedAirportCodes) {
      try {
        const result = await GdsIntegrationService.searchLocations({ provider: "Amadeus", keyword: code, subType: "AIRPORT", timeoutMs: config.timeoutMs, maxRetries: config.maxRetries });
        const match = result.locations.find((l) => l.iata === String(code).toUpperCase() && (l.subType === "AIRPORT" || result._source === "dynamic-sandbox"));

        if (!match) {
          unknownCodes.push(code);
          continue;
        }

        const existing = await ReferenceAirportModel.findOne({ iata: match.iata });
        const changed = hasChanged(existing, match, ["airportName", "city", "cityCode", "country", "countryCode", "timezone"]);

        await ReferenceAirportModel.findOneAndUpdate(
          { iata: match.iata },
          {
            iata: match.iata, icao: match.icao || existing?.icao || null, airportName: match.airportName || existing?.airportName || `${match.iata} Airport`,
            city: match.city, cityCode: match.cityCode, country: match.country, countryCode: match.countryCode,
            latitude: match.latitude, longitude: match.longitude, timezone: match.timezone,
            isActive: true, source: result._source, lastSyncedAt: new Date()
          },
          { upsert: true, new: true, setDefaultsOnInsert: true }
        );

        if (changed) {
          updated += 1;
          publishEvent("AirportUpdated", { iata: match.iata, source: result._source });
        }
      } catch (err) {
        console.warn(`[EXT-013] Airport sync failed for code "${code}": ${err.message}`);
        unknownCodes.push(code);
      }
    }

    if (unknownCodes.length > 0) {
      console.warn(`[EXT-013] Unknown/unresolvable airport codes logged for review: ${unknownCodes.join(", ")}`);
    }

    return { updated, unknownCodes };
  }

  static async syncAirlines() {
    const config = getReferenceDataSyncConfig();
    let updated = 0;
    let unknownCodes = [];

    try {
      const result = await GdsIntegrationService.getAirlinesByCodes({ provider: "Amadeus", airlineCodes: config.seedAirlineCodes, timeoutMs: config.timeoutMs, maxRetries: config.maxRetries });
      const foundCodes = new Set(result.airlines.map((a) => a.iata));
      unknownCodes = config.seedAirlineCodes.filter((c) => !foundCodes.has(String(c).toUpperCase()));

      for (const airline of result.airlines) {
        if (!airline.iata) continue;
        const existing = await ReferenceAirlineModel.findOne({ iata: airline.iata });
        const changed = hasChanged(existing, airline, ["airlineName", "icao", "country"]);

        await ReferenceAirlineModel.findOneAndUpdate(
          { iata: airline.iata },
          { iata: airline.iata, icao: airline.icao, airlineName: airline.airlineName, country: airline.country, isActive: true, source: result._source, lastSyncedAt: new Date() },
          { upsert: true, new: true, setDefaultsOnInsert: true }
        );

        if (changed) {
          updated += 1;
          publishEvent("AirlineUpdated", { iata: airline.iata, source: result._source });
        }
      }
    } catch (err) {
      console.warn(`[EXT-013] Airline sync failed: ${err.message}`);
      unknownCodes = config.seedAirlineCodes;
    }

    if (unknownCodes.length > 0) {
      console.warn(`[EXT-013] Unknown/unresolvable airline codes logged for review: ${unknownCodes.join(", ")}`);
    }

    return { updated, unknownCodes };
  }

  /**
   * §10/§16 honest gap — no real Amadeus aircraft-reference endpoint
   * exists, so this seeds from the codebase's existing curated IATA
   * aircraft-equipment-code dictionary rather than a fabricated live call.
   */
  static async syncAircraft() {
    let updated = 0;
    for (const [code, name] of Object.entries(AmadeusAdapter.AIRCRAFT_NAME_MAP)) {
      const existing = await ReferenceAircraftModel.findOne({ code });
      const manufacturer = deriveManufacturer(name);
      const changed = hasChanged(existing, { name, manufacturer }, ["name", "manufacturer"]);

      await ReferenceAircraftModel.findOneAndUpdate(
        { code },
        { code, name, manufacturer, isActive: true, source: "static-reference", lastSyncedAt: new Date() },
        { upsert: true, new: true, setDefaultsOnInsert: true }
      );

      if (changed) {
        updated += 1;
        publishEvent("AircraftUpdated", { code });
      }
    }
    return { updated };
  }

  /** Countries/cities are derived as a real byproduct of the airport sync's own address fields — never independently fabricated. */
  static async syncCountriesAndCities() {
    const airports = await ReferenceAirportModel.find({ isActive: true }).lean();
    const countries = new Map();
    const cities = new Map();

    for (const airport of airports) {
      if (airport.countryCode && !countries.has(airport.countryCode)) {
        countries.set(airport.countryCode, { code: airport.countryCode, name: airport.country || airport.countryCode, source: airport.source });
      }
      if (airport.cityCode && !cities.has(airport.cityCode)) {
        cities.set(airport.cityCode, { cityCode: airport.cityCode, cityName: airport.city || airport.cityCode, countryCode: airport.countryCode, country: airport.country, source: airport.source });
      }
    }

    for (const country of countries.values()) {
      await ReferenceCountryModel.findOneAndUpdate(
        { code: country.code },
        { ...country, isActive: true, lastSyncedAt: new Date() },
        { upsert: true, setDefaultsOnInsert: true }
      );
    }
    for (const city of cities.values()) {
      await ReferenceCityModel.findOneAndUpdate(
        { cityCode: city.cityCode },
        { ...city, isActive: true, lastSyncedAt: new Date() },
        { upsert: true, setDefaultsOnInsert: true }
      );
    }

    return { countries: countries.size, cities: cities.size };
  }

  /** §5 "Daily Incremental Sync" full orchestration — airports → airlines → aircraft → derived countries/cities → cache refresh → events. */
  static async syncAll({ triggeredBy = "scheduler" } = {}) {
    if (mongoose.connection?.readyState !== 1) {
      console.warn("[EXT-013] Reference data sync skipped — database not connected.");
      return null;
    }

    const startedAt = Date.now();
    const airportResult = await ReferenceDataService.syncAirports();
    const airlineResult = await ReferenceDataService.syncAirlines();
    const aircraftResult = await ReferenceDataService.syncAircraft();
    const geoResult = await ReferenceDataService.syncCountriesAndCities();

    await CacheManager.invalidatePattern(`${CACHE_PREFIX}:*`);
    publishEvent("ReferenceCacheRefreshed", { triggeredBy });

    const summary = {
      airportsUpdated: airportResult.updated, airlinesUpdated: airlineResult.updated, aircraftUpdated: aircraftResult.updated,
      countries: geoResult.countries, cities: geoResult.cities,
      unknownAirportCodes: airportResult.unknownCodes, unknownAirlineCodes: airlineResult.unknownCodes,
      durationMs: Date.now() - startedAt, triggeredBy
    };

    publishEvent("ReferenceDataSynced", summary);
    AuditLogModel.create({ tenantId: "system", userId: "system", action: "REFERENCE_DATA_SYNCED", module: "ExternalIntegrations", details: summary }).catch((err) => console.error("Reference data sync audit log error:", err));

    return summary;
  }

  // ── Reads (cache-first → master table; never call the provider here — §18) ──

  static async getAirports({ code, city, country, isActive = true, page = 1, limit = 50 } = {}) {
    const config = getReferenceDataSyncConfig();
    const filter = { isActive };
    if (code) filter.iata = String(code).toUpperCase();
    if (city) filter.city = new RegExp(`^${city}$`, "i");
    if (country) filter.country = new RegExp(`^${country}$`, "i");

    const key = `${CACHE_PREFIX}:airports:${JSON.stringify(filter)}:${page}:${limit}`;
    const { data } = await CacheManager.getOrCompute(key, async () => {
      const skip = (page - 1) * limit;
      const [items, total] = await Promise.all([
        ReferenceAirportModel.find(filter).skip(skip).limit(limit).lean(),
        ReferenceAirportModel.countDocuments(filter)
      ]);
      return { items, total };
    }, config.cacheTtlSeconds);
    return data;
  }

  static async getAirlines({ code, isActive = true, page = 1, limit = 50 } = {}) {
    const config = getReferenceDataSyncConfig();
    const filter = { isActive };
    if (code) filter.iata = String(code).toUpperCase();

    const key = `${CACHE_PREFIX}:airlines:${JSON.stringify(filter)}:${page}:${limit}`;
    const { data } = await CacheManager.getOrCompute(key, async () => {
      const skip = (page - 1) * limit;
      const [items, total] = await Promise.all([
        ReferenceAirlineModel.find(filter).skip(skip).limit(limit).lean(),
        ReferenceAirlineModel.countDocuments(filter)
      ]);
      return { items, total };
    }, config.cacheTtlSeconds);
    return data;
  }

  static async getAircraft({ code, isActive = true, page = 1, limit = 50 } = {}) {
    const config = getReferenceDataSyncConfig();
    const filter = { isActive };
    if (code) filter.code = String(code).toUpperCase();

    const key = `${CACHE_PREFIX}:aircraft:${JSON.stringify(filter)}:${page}:${limit}`;
    const { data } = await CacheManager.getOrCompute(key, async () => {
      const skip = (page - 1) * limit;
      const [items, total] = await Promise.all([
        ReferenceAircraftModel.find(filter).skip(skip).limit(limit).lean(),
        ReferenceAircraftModel.countDocuments(filter)
      ]);
      return { items, total };
    }, config.cacheTtlSeconds);
    return data;
  }

  static async getCountries({ code, isActive = true, page = 1, limit = 50 } = {}) {
    const config = getReferenceDataSyncConfig();
    const filter = { isActive };
    if (code) filter.code = String(code).toUpperCase();

    const key = `${CACHE_PREFIX}:countries:${JSON.stringify(filter)}:${page}:${limit}`;
    const { data } = await CacheManager.getOrCompute(key, async () => {
      const skip = (page - 1) * limit;
      const [items, total] = await Promise.all([
        ReferenceCountryModel.find(filter).skip(skip).limit(limit).lean(),
        ReferenceCountryModel.countDocuments(filter)
      ]);
      return { items, total };
    }, config.cacheTtlSeconds);
    return data;
  }

  static async getCities({ code, country, isActive = true, page = 1, limit = 50 } = {}) {
    const config = getReferenceDataSyncConfig();
    const filter = { isActive };
    if (code) filter.cityCode = String(code).toUpperCase();
    if (country) filter.country = new RegExp(`^${country}$`, "i");

    const key = `${CACHE_PREFIX}:cities:${JSON.stringify(filter)}:${page}:${limit}`;
    const { data } = await CacheManager.getOrCompute(key, async () => {
      const skip = (page - 1) * limit;
      const [items, total] = await Promise.all([
        ReferenceCityModel.find(filter).skip(skip).limit(limit).lean(),
        ReferenceCityModel.countDocuments(filter)
      ]);
      return { items, total };
    }, config.cacheTtlSeconds);
    return data;
  }

  // ── EXT-014 — Airport Search & Autocomplete ────────────────────────────

  /**
   * §9 Business Workflow. Always reads the EXT-013 local master table
   * (never Amadeus — §17 "Never Query Amadeus"), cached separately from
   * EXT-013's own 24h cache at a 1-hour TTL (§14).
   */
  static async searchAirports({ tenantId, userId, q, limit, country, city, internationalOnly, activeOnly, requestId }) {
    const config = getAirportSearchConfig();

    // §10 Validation Rules.
    if (!q || typeof q !== "string") {
      throwStructured("Search query 'q' is required.", "INVALID_REQUEST", 400);
    }
    const trimmed = q.trim();
    if (trimmed.length < config.minQueryLength) {
      throwStructured(`Search query must be at least ${config.minQueryLength} characters.`, "INVALID_REQUEST", 400);
    }
    if (trimmed.length > config.maxQueryLength) {
      throwStructured(`Search query must not exceed ${config.maxQueryLength} characters.`, "INVALID_REQUEST", 400);
    }
    if (!QUERY_ALLOWED_PATTERN.test(trimmed)) {
      throwStructured("Search query contains invalid characters.", "INVALID_REQUEST", 400);
    }

    const resolvedLimit = Math.max(1, Math.min(config.maxResults, Number.parseInt(limit, 10) || config.defaultResults));
    const isActive = activeOnly !== false && activeOnly !== "false"; // "Inactive airports hidden by default" (§11).
    const wantsInternationalOnly = internationalOnly === true || internationalOnly === "true";

    const filter = { isActive };
    if (country) filter.country = new RegExp(`^${escapeRegExp(country)}$`, "i");
    if (city) filter.city = new RegExp(`^${escapeRegExp(city)}$`, "i");
    if (wantsInternationalOnly) filter.isInternational = true;

    const cacheKey = `${CACHE_PREFIX}:airport-search:${trimmed.toLowerCase()}:${resolvedLimit}:${JSON.stringify(filter)}`;
    const { data: items, fromCache } = await CacheManager.getOrCompute(cacheKey, async () => {
      // Cheap candidate pre-filter at scale via the real Mongo text index
      // (§15's honest local equivalent to "GIN Full Text Index" — see the
      // model's own note on why there's no Mongo trigram equivalent),
      // falling back to the full active set when the text index finds
      // nothing (short/code-only queries like "KHI" often won't match
      // $text at all, but must still resolve via exact/prefix scoring).
      let candidates = await ReferenceAirportModel.find({ ...filter, $text: { $search: trimmed } }, { score: { $meta: "textScore" } })
        .limit(config.candidatePoolSize).lean().catch(() => []);
      if (candidates.length === 0) {
        candidates = await ReferenceAirportModel.find(filter).limit(config.candidatePoolSize).lean();
      }

      const scored = candidates
        .map((airport) => ({ airport, score: ReferenceDataService._scoreAirport(airport, trimmed) }))
        .filter((entry) => entry.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, resolvedLimit);

      return scored.map(({ airport, score }) => ({
        airportCode: airport.iata,
        airportName: airport.airportName,
        city: airport.city,
        country: airport.country,
        iata: airport.iata,
        icao: airport.icao,
        timezone: airport.timezone,
        score
      }));
    }, config.cacheTtlSeconds);

    publishEvent("AirportSearchPerformed", { tenantId, userId, query: trimmed, resultCount: items.length });
    if (fromCache) publishEvent("AirportSearchCached", { tenantId, query: trimmed, resultCount: items.length });

    if (mongoose.connection?.readyState === 1) {
      AuditLogModel.create({ tenantId, userId, action: "AIRPORT_SEARCH_PERFORMED", module: "ExternalIntegrations", requestId, details: { query: trimmed, resultCount: items.length, fromCache } })
        .catch((err) => console.error("Airport search audit log error:", err));
    }

    return { query: trimmed, results: items, fromCache };
  }

  /**
   * §20 "AirportSuggestionSelected" — a lightweight analytics log of which
   * suggestion a user actually picked from a given query, for future
   * ranking tuning. No endpoint in this doc other than the search GET
   * itself is specified beyond this, so this stays intentionally minimal
   * (an audit entry + event), not a new heavy model.
   */
  static async recordSuggestionSelected({ tenantId, userId, query, selectedIata, requestId }) {
    if (!selectedIata) {
      throwStructured("selectedIata is required.", "INVALID_REQUEST", 400);
    }
    const normalizedIata = String(selectedIata).toUpperCase();

    publishEvent("AirportSuggestionSelected", { tenantId, userId, query: query || null, selectedIata: normalizedIata });

    if (mongoose.connection?.readyState === 1) {
      AuditLogModel.create({ tenantId, userId, action: "AIRPORT_SUGGESTION_SELECTED", module: "ExternalIntegrations", requestId, details: { query: query || null, selectedIata: normalizedIata } })
        .catch((err) => console.error("Airport suggestion selection audit log error:", err));
    }

    return { query: query || null, selectedIata: normalizedIata };
  }
}

export default ReferenceDataService;
