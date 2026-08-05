import { getAirlineApiCredentials, getAirlineCheckInRegistry, getAirlineCheckInPolicy } from "../utils/airlineCheckInConfig.js";

/**
 * EXT-010 — Generic (non-Amadeus) airline check-in adapter layer. Real
 * airline check-in is a per-airline commercial/technical integration
 * (Emirates, Qatar, Turkish, PIA, Saudia, etc. each have their own
 * proprietary partner API — there is no single installable SDK the way
 * Amadeus's Self-Service catalog provides for search/pricing/booking). This
 * class therefore only attempts a real HTTP call when a tenant has actually
 * configured that specific airline's base URL + API key; every unconfigured
 * airline honestly reports itself as unsupported rather than faking success.
 */
class AirlineCheckInAdapterService {
  static isApiSupported(airlineCode) {
    const { baseUrl, apiKey } = getAirlineApiCredentials(airlineCode);
    return Boolean(baseUrl && apiKey);
  }

  static getRedirectInfo(airlineCode) {
    const registry = getAirlineCheckInRegistry();
    const entry = airlineCode ? registry[String(airlineCode).toUpperCase()] : null;
    return {
      airlineName: entry?.airlineName || airlineCode || "the airline",
      checkInUrl: entry?.checkInUrl || null
    };
  }

  /**
   * Real HTTP call to a tenant-configured airline check-in API. A generic
   * REST convention (`POST {baseUrl}/checkin` with a bearer token) since no
   * airline-specific SDK exists to install — only ever invoked when
   * isApiSupported() is true for that airline.
   */
  static async performCheckIn({ airlineCode, pnr, travelerIds }) {
    const { baseUrl, apiKey } = getAirlineApiCredentials(airlineCode);
    if (!baseUrl || !apiKey) {
      const err = new Error(`No configured check-in API for airline ${airlineCode}.`);
      err.code = "AIRLINE_API_NOT_SUPPORTED";
      err.status = 400;
      throw err;
    }

    const { timeoutMs } = getAirlineCheckInPolicy();
    let res;
    try {
      res = await fetch(`${baseUrl.replace(/\/$/, "")}/checkin`, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ pnr, travelerIds }),
        signal: AbortSignal.timeout(timeoutMs)
      });
    } catch (err) {
      const isTimeout = err.name === "TimeoutError" || err.name === "AbortError";
      const wrapped = new Error(isTimeout ? `Check-in request to ${airlineCode} timed out.` : `Network error calling ${airlineCode} check-in API: ${err.message}`);
      wrapped.code = isTimeout ? "PROVIDER_TIMEOUT" : "PROVIDER_UNAVAILABLE";
      wrapped.status = isTimeout ? 504 : 502;
      throw wrapped;
    }

    if (!res.ok) {
      const err = new Error(`${airlineCode} check-in API returned ${res.status}.`);
      err.code = res.status === 429 ? "RATE_LIMIT_EXCEEDED" : "PROVIDER_UNAVAILABLE";
      err.status = res.status === 429 ? 429 : 502;
      throw err;
    }

    // Expected shape: { travelers: [{ travelerId, seat, boardingPassUrl }] }
    // or { travelers: [{ travelerId, seat, boardingPassBase64, mimeType }] }
    // — this codebase has no live airline partner to confirm an exact
    // response contract against, so both a direct URL and an inline file are
    // supported by the orchestration layer (FlightCheckInService).
    return await res.json();
  }
}

export default AirlineCheckInAdapterService;
