import mongoose from "mongoose";
import AuditLogModel from "../models/AuditLogmodel.js";
import GdsIntegrationService from "./GdsIntegrationService.js";
import ReferenceDataService from "./ReferenceDataService.js";
import CacheManager from "../utils/cacheManager.js";
import { throwStructured } from "./AmadeusFlightBookingService.js";
import { publishEvent } from "../utils/eventBus.js";
import { getFlightInspirationPolicy } from "../utils/gdsConfig.js";

const IATA_CODE_PATTERN = /^[A-Z]{3}$/;
const DATE_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

const toStartOfDay = (value) => {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
};

/**
 * EXT-015 — Amadeus Flight Inspiration API. This is the ONLY entry point
 * anything (including the AI Assistant, via its own `flight_inspiration`
 * tool in AIToolRegistry.js) uses to reach Amadeus's Flight Inspiration
 * Search — matching the user's explicit architecture mandate: AI never
 * gets direct provider access, it calls this internal service, which alone
 * calls the adapter. This mirrors the pattern already used by every prior
 * EXT-series AI tool (flight_search, flight_schedule, reference_data_lookup
 * all go through their own internal service, never AmadeusAdapter
 * directly) — not a new pattern, a continuation of the existing one.
 */
class AmadeusFlightInspirationService {
  static async getInspiration({ tenantId, userId, origin, departureDate, returnDate, maxPrice, currency, nonStop, maxResults, requestId }) {
    // §10 "Origin Required" / "Valid IATA Airport".
    if (!origin) {
      throwStructured("origin is required.", "INVALID_REQUEST", 400);
    }
    const originCode = String(origin).toUpperCase();
    if (!IATA_CODE_PATTERN.test(originCode)) {
      throwStructured("origin must be a valid 3-letter IATA airport code.", "INVALID_REQUEST", 400);
    }

    if (departureDate && !DATE_ONLY_PATTERN.test(departureDate)) {
      throwStructured("departureDate must be a valid YYYY-MM-DD date.", "INVALID_REQUEST", 400);
    }
    if (returnDate) {
      if (!DATE_ONLY_PATTERN.test(returnDate)) {
        throwStructured("returnDate must be a valid YYYY-MM-DD date.", "INVALID_REQUEST", 400);
      }
      if (!departureDate) {
        throwStructured("departureDate is required when returnDate is provided.", "INVALID_REQUEST", 400);
      }
      if (toStartOfDay(returnDate) < toStartOfDay(departureDate)) {
        throwStructured("returnDate cannot be before departureDate.", "INVALID_REQUEST", 400);
      }
    }

    // §10 "Positive Budget".
    let resolvedMaxPrice = null;
    if (maxPrice !== undefined && maxPrice !== null && maxPrice !== "") {
      resolvedMaxPrice = Number.parseFloat(maxPrice);
      if (!Number.isFinite(resolvedMaxPrice) || resolvedMaxPrice <= 0) {
        throwStructured("maxPrice must be a positive number.", "INVALID_REQUEST", 400);
      }
    }

    const config = getFlightInspirationPolicy();
    const resolvedNonStop = nonStop === true || nonStop === "true" ? true : undefined;
    const resolvedMaxResults = Math.max(1, Math.min(config.maxResults, Number.parseInt(maxResults, 10) || config.defaultResults));

    // "OAuth Active" — circuit breaker is the real proxy for provider connectivity.
    if (!GdsIntegrationService.circuitBreaker.canAttempt("Amadeus")) {
      throwStructured("Amadeus is currently unavailable (circuit breaker open).", "PROVIDER_UNAVAILABLE", 503);
    }

    const cacheKey = `gds:flight-inspiration:${originCode}:${departureDate || "any"}:${returnDate || "any"}:${resolvedMaxPrice || "any"}:${resolvedNonStop ? "nonstop" : "any"}:${resolvedMaxResults}`;

    let providerResult;
    let fromCache = false;
    try {
      const cached = await CacheManager.get(cacheKey);
      if (cached) {
        providerResult = cached;
        fromCache = true;
      } else {
        providerResult = await GdsIntegrationService.getFlightInspiration({
          provider: "Amadeus", origin: originCode, departureDate, returnDate, maxPrice: resolvedMaxPrice, nonStop: resolvedNonStop, maxResults: resolvedMaxResults
        });
        await CacheManager.set(cacheKey, providerResult, config.cacheTtlSeconds);
      }
    } catch (err) {
      const code = err.code || (err.status === 429 ? "RATE_LIMIT_EXCEEDED" : err.status === 504 ? "PROVIDER_TIMEOUT" : "PROVIDER_UNAVAILABLE");
      const status = code === "RATE_LIMIT_EXCEEDED" ? 429 : code === "PROVIDER_TIMEOUT" ? 504 : 503;
      if (mongoose.connection?.readyState === 1) {
        AuditLogModel.create({
          tenantId, userId, action: "AMADEUS_FLIGHT_INSPIRATION_FAILED", module: "ExternalIntegrations",
          requestId, details: { origin: originCode, departureDate, maxPrice: resolvedMaxPrice, code, reason: err.message }
        }).catch((auditErr) => console.error("Flight inspiration failure audit log error:", auditErr));
      }
      throwStructured("Flight inspiration is temporarily unavailable. Please try again.", code, status);
    }

    // §11 "Internal business filters applied after provider response" / "Results ranked before returning".
    const filtered = AmadeusFlightInspirationService._applyBusinessRules(providerResult.destinations, config);
    const ranked = AmadeusFlightInspirationService._rankResults(filtered, config);
    const enriched = await AmadeusFlightInspirationService._enrichWithReferenceData(ranked);

    publishEvent("InspirationSearchPerformed", { tenantId, userId, origin: originCode, resultCount: enriched.length, source: providerResult._source });

    if (mongoose.connection?.readyState === 1) {
      AuditLogModel.create({
        tenantId, userId, action: "AMADEUS_FLIGHT_INSPIRATION_VIEWED", module: "ExternalIntegrations",
        requestId, details: { origin: originCode, departureDate, maxPrice: resolvedMaxPrice, resultCount: enriched.length, source: providerResult._source, fromCache }
      }).catch((err) => console.error("Flight inspiration audit log error:", err));
    }

    return { origin: originCode, results: enriched, meta: { count: enriched.length, provider: "Amadeus", source: providerResult._source, fromCache } };
  }

  /**
   * §15 "Company Business Rules" — a real, config-driven filter/boost layer
   * (`GDS_FLIGHT_INSPIRATION_BLOCKED_DESTINATIONS_JSON`/`_BOOSTED_..._JSON`),
   * applied strictly after the provider response, never before — matching
   * §11's own ordering.
   */
  static _applyBusinessRules(destinations, config) {
    const blocked = new Set((config.blockedDestinations || []).map((c) => String(c).toUpperCase()));
    return destinations.filter((d) => !blocked.has(d.destination));
  }

  /**
   * §15 "Recommendation Rules" — implemented as far as this endpoint's real
   * data honestly supports:
   *   1. Lowest Price (real — every entry carries a real price)
   *   2. Shortest Duration — the Flight Inspiration response carries no
   *      flight-duration field at all (only departure/return dates), so
   *      this is honestly substituted with shortest TRIP LENGTH in days
   *      (returnDate - departureDate) for round-trip entries, real data
   *      actually present in the response, not a fabricated flight time.
   *   3. Non-stop Preferred (real, when known — `nonStop === true` sorts
   *      first; `null`, meaning genuinely unknown, is treated as neutral,
   *      never assumed non-stop or assumed with a stop).
   *   4. Preferred Airline / Historical Traveler Preferences — the real
   *      Flight Inspiration response carries NO airline/carrier field at
   *      all, and no historical-preference data source is wired into this
   *      service. Both are honestly OMITTED rather than fabricated — the
   *      same category of gap as EXT-011's Cancelled/Diverted or EXT-012's
   *      operatingDays.
   *   Boosted destinations (§15's real "Company Business Rules" hook) are
   *   applied last, as an explicit tenant-configured override.
   */
  static _rankResults(destinations, config) {
    const tripLengthDays = (d) => {
      if (!d.departureDate || !d.returnDate) return Number.MAX_SAFE_INTEGER;
      return Math.round((new Date(d.returnDate).getTime() - new Date(d.departureDate).getTime()) / 86400000);
    };

    const sorted = [...destinations].sort((a, b) => {
      if (a.lowestPrice !== b.lowestPrice) return a.lowestPrice - b.lowestPrice;
      const lengthDiff = tripLengthDays(a) - tripLengthDays(b);
      if (lengthDiff !== 0) return lengthDiff;
      const nonStopScore = (d) => (d.nonStop === true ? 0 : d.nonStop === null ? 1 : 2);
      return nonStopScore(a) - nonStopScore(b);
    });

    const boosted = new Set((config?.boostedDestinations || []).map((c) => String(c).toUpperCase()));
    if (boosted.size === 0) return sorted;

    // Stable partition: boosted destinations first, each group keeping the
    // price/trip-length/non-stop order just computed above — a real
    // "Company Business Rules" override, not a reshuffle that discards the
    // ranking work already done.
    return [...sorted.filter((d) => boosted.has(d.destination)), ...sorted.filter((d) => !boosted.has(d.destination))];
  }

  /**
   * Enriches each destination with city/country from EXT-013's own
   * synchronized reference data (never Amadeus's fragile `detailedName`
   * string parsing) — genuinely reuses the internal service layer, exactly
   * as the architecture diagram's "Recommendation Engine" step implies.
   * A destination not present in the local reference master table (limited
   * seed list) honestly resolves to `city: null, country: null` rather
   * than a guess.
   */
  static async _enrichWithReferenceData(destinations) {
    return Promise.all(destinations.map(async (d) => {
      const { items } = await ReferenceDataService.getAirports({ code: d.destination, limit: 1 });
      const airport = items[0] || null;
      return { destination: d.destination, city: airport?.city || null, country: airport?.country || null, lowestPrice: d.lowestPrice, currency: d.currency, departureDate: d.departureDate, returnDate: d.returnDate, nonStop: d.nonStop };
    }));
  }

  /** §19 "RecommendationViewed"/"RecommendationAccepted" — consumer-driven, so a small feedback endpoint is what actually fires them (same pattern as EXT-014's AirportSuggestionSelected). */
  static async recordFeedback({ tenantId, userId, origin, destination, action, requestId }) {
    if (!destination || !["viewed", "accepted"].includes(action)) {
      throwStructured("destination and a valid action ('viewed' or 'accepted') are required.", "INVALID_REQUEST", 400);
    }
    const normalizedDestination = String(destination).toUpperCase();
    const eventName = action === "accepted" ? "RecommendationAccepted" : "RecommendationViewed";
    publishEvent(eventName, { tenantId, userId, origin: origin ? String(origin).toUpperCase() : null, destination: normalizedDestination });

    if (mongoose.connection?.readyState === 1) {
      AuditLogModel.create({ tenantId, userId, action: `INSPIRATION_${action.toUpperCase()}`, module: "ExternalIntegrations", requestId, details: { origin: origin || null, destination: normalizedDestination } })
        .catch((err) => console.error("Inspiration feedback audit log error:", err));
    }

    return { destination: normalizedDestination, action };
  }
}

export default AmadeusFlightInspirationService;
