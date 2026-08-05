import dotenv from "dotenv";
dotenv.config();

const parseNumber = (value, fallback) => {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const parseJsonArray = (value, fallback) => {
  if (!value) return fallback;
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : fallback;
  } catch {
    return fallback;
  }
};

// A real, reasonable starting seed set for a Pakistan/Gulf-focused travel
// ERP — fully overridable via env, since Amadeus's Self-Service tier has no
// "list every airport/airline in the world" bulk endpoint to sync from
// unprompted (see EXT-013 doc §4 "Synchronization Strategy" honest-gap
// note). Operators add codes relevant to their own route network here.
const DEFAULT_SEED_AIRPORT_CODES = ["KHI", "LHE", "ISB", "JED", "MED", "DXB", "DOH", "IST", "LHR", "JFK"];
const DEFAULT_SEED_AIRLINE_CODES = ["SV", "EK", "QR", "TK", "PK", "EY", "GF", "TG", "BA", "LH"];

/**
 * EXT-013 §5/§6/§12/§18 — daily incremental sync, 24h Redis cache, "never
 * call Amadeus for every request" (serve from synchronized master tables).
 */
export const getReferenceDataSyncConfig = () => ({
  cronSchedule: process.env.REFERENCE_DATA_SYNC_CRON_SCHEDULE || "0 3 * * *",
  timeoutMs: parseNumber(process.env.REFERENCE_DATA_SYNC_TIMEOUT_MS, 15000),
  maxRetries: parseNumber(process.env.REFERENCE_DATA_SYNC_MAX_RETRIES, 1),
  cacheTtlSeconds: parseNumber(process.env.REFERENCE_DATA_CACHE_TTL_SECONDS, 86400),
  seedAirportCodes: parseJsonArray(process.env.REFERENCE_DATA_SEED_AIRPORT_CODES_JSON, DEFAULT_SEED_AIRPORT_CODES),
  seedAirlineCodes: parseJsonArray(process.env.REFERENCE_DATA_SEED_AIRLINE_CODES_JSON, DEFAULT_SEED_AIRLINE_CODES)
});

/**
 * EXT-014 §10/§14 — search validation bounds and its own 1-hour cache tier,
 * distinct from EXT-013's 24h reference-data cache (§14 explicitly gives
 * autocomplete a shorter TTL than the underlying master data it reads).
 */
export const getAirportSearchConfig = () => ({
  minQueryLength: parseNumber(process.env.AIRPORT_SEARCH_MIN_QUERY_LENGTH, 2),
  maxQueryLength: parseNumber(process.env.AIRPORT_SEARCH_MAX_QUERY_LENGTH, 100),
  maxResults: parseNumber(process.env.AIRPORT_SEARCH_MAX_RESULTS, 20),
  defaultResults: parseNumber(process.env.AIRPORT_SEARCH_DEFAULT_RESULTS, 10),
  cacheTtlSeconds: parseNumber(process.env.AIRPORT_SEARCH_CACHE_TTL_SECONDS, 3600),
  candidatePoolSize: parseNumber(process.env.AIRPORT_SEARCH_CANDIDATE_POOL_SIZE, 2000)
});

export default getReferenceDataSyncConfig;
