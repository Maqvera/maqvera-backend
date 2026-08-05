import dotenv from "dotenv";
dotenv.config();

const parseNumber = (value, fallback) => {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const parseJson = (value, fallback) => {
  if (!value) return fallback;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? parsed : fallback;
  } catch {
    return fallback;
  }
};

// EXT-010 — "Airline Capability Detection." Only the airline's real, public
// root domain is used as a redirect default (not a guessed deep-link path,
// which could easily be wrong/outdated). Every entry is overridable via
// AIRLINE_CHECKIN_REGISTRY_JSON — operators should replace these with the
// exact current check-in deep link for each airline partnership before
// relying on this in production.
const DEFAULT_AIRLINE_REGISTRY = {
  EK: { airlineName: "Emirates", checkInUrl: "https://www.emirates.com" },
  QR: { airlineName: "Qatar Airways", checkInUrl: "https://www.qatarairways.com" },
  TK: { airlineName: "Turkish Airlines", checkInUrl: "https://www.turkishairlines.com" },
  SV: { airlineName: "Saudia", checkInUrl: "https://www.saudia.com" },
  PK: { airlineName: "PIA", checkInUrl: "https://www.piac.com.pk" }
};

/**
 * Static registry of known airlines (name + web check-in fallback URL).
 * Whether an airline's REAL API is usable is a separate, per-tenant runtime
 * question — see getAirlineApiCredentials() — because a real API
 * integration requires actual commercial credentials this registry cannot
 * assume exist.
 */
export const getAirlineCheckInRegistry = () => parseJson(process.env.AIRLINE_CHECKIN_REGISTRY_JSON, DEFAULT_AIRLINE_REGISTRY);

/**
 * Per-airline API credentials, e.g. AIRLINE_CHECKIN_EK_BASE_URL /
 * AIRLINE_CHECKIN_EK_API_KEY for Emirates. Only present when a tenant has
 * a real commercial integration with that specific airline — absent by
 * default for every airline, which is the honest, correct state for this
 * codebase today (no airline-specific SDK/credentials are configured
 * anywhere).
 */
export const getAirlineApiCredentials = (airlineCode) => {
  if (!airlineCode) return { baseUrl: null, apiKey: null };
  const code = String(airlineCode).toUpperCase();
  return {
    baseUrl: process.env[`AIRLINE_CHECKIN_${code}_BASE_URL`] || null,
    apiKey: process.env[`AIRLINE_CHECKIN_${code}_API_KEY`] || null
  };
};

export const getAirlineCheckInPolicy = () => ({
  timeoutMs: parseNumber(process.env.AIRLINE_CHECKIN_TIMEOUT_MS, 15000)
});
