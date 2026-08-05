import crypto from "crypto";
import GdsIntegrationService from "./GdsIntegrationService.js";
import FlightOfferMapper from "./external/FlightOfferMapper.js";
import AmadeusMetricsService from "./external/AmadeusMetricsService.js";
import CacheManager from "../utils/cacheManager.js";
import { getAmadeusHttpPolicy } from "../utils/gdsConfig.js";
import { publishEvent } from "../utils/eventBus.js";

/**
 * EXT-002 — Amadeus Flight Search Integration. A dedicated, single-provider
 * service distinct from GdsIntegrationService.searchFlights (which is the
 * multi-provider, ERP-internal search behind API-006B and does Amadeus→
 * Sabre failover). Per this document's own scope ("sirf Amadeus integration
 * karna hai, Sabre/Travelport baad mein plugin ki tarah add honge"), this
 * service talks to Amadeus only and returns the provider-independent
 * Standard Flight DTO (via FlightOfferMapper), never the internal shape
 * API-006B/006C/006D/AIToolRegistry already depend on.
 */
class AmadeusFlightSearchService {
  static _cacheKey(params) {
    const normalized = JSON.stringify({
      origin: params.origin, destination: params.destination, departureDate: params.departureDate,
      returnDate: params.returnDate || null, adults: params.adults, children: params.children || 0,
      infants: params.infants || 0, travelClass: params.travelClass, nonStop: Boolean(params.nonStop), currency: params.currency
    });
    return `ext:amadeus-flight-search:${crypto.createHash("sha1").update(normalized).digest("hex")}`;
  }

  /**
   * "Business Workflow: ... Load OAuth Token → Call Amadeus API → Normalize
   * Response → Apply Internal Filters → Audit → Return Response." Validation
   * (§8) happens one layer up, in the controller, matching this codebase's
   * established convention for every other search endpoint.
   */
  static async search(params) {
    const correlationId = params.correlationId || `EXTSEARCH-${crypto.randomUUID()}`;
    publishEvent("FlightSearchPerformed", { correlationId, tenantId: params.tenantId, provider: "Amadeus", params: { origin: params.origin, destination: params.destination, departureDate: params.departureDate } });

    const cacheKey = this._cacheKey(params);
    const cached = await CacheManager.get(cacheKey);
    if (cached) {
      AmadeusMetricsService.recordCacheHit();
      AmadeusMetricsService.recordSearch(0, true);
      publishEvent("FlightSearchCompleted", { correlationId, tenantId: params.tenantId, provider: "Amadeus", totalOffers: cached.length, fromCache: true });
      return { offers: cached, fromCache: true, correlationId };
    }
    AmadeusMetricsService.recordCacheMiss();

    const startedAt = Date.now();
    // Shares the exact same circuit breaker instance API-006B's internal
    // search already uses against this same downstream provider — a
    // failure discovered by one search path should count against the
    // other, since they're calling the literal same Amadeus API.
    if (!GdsIntegrationService.circuitBreaker.canAttempt("Amadeus")) {
      const err = new Error("Amadeus is currently unavailable (circuit breaker open).");
      err.code = "PROVIDER_UNAVAILABLE";
      AmadeusMetricsService.recordSearch(Date.now() - startedAt, false);
      throw err;
    }

    const adapter = GdsIntegrationService.getAdapter("Amadeus");
    let rawResult;
    try {
      // Reuses the same retry infrastructure already proven for API-006B/E,
      // rather than duplicating it here.
      rawResult = await GdsIntegrationService._callWithRetry(adapter, "searchFlights", [{
        origin: params.origin,
        destination: params.destination,
        departureDate: params.departureDate,
        returnDate: params.returnDate,
        adults: params.adults,
        cabin: params.travelClass || "Economy",
        currency: params.currency
      }]);
      GdsIntegrationService.circuitBreaker.recordSuccess("Amadeus");
    } catch (err) {
      GdsIntegrationService.circuitBreaker.recordFailure("Amadeus");
      const durationMs = Date.now() - startedAt;
      AmadeusMetricsService.recordSearch(durationMs, false);
      throw err;
    }

    let offers = FlightOfferMapper.toDTOList(rawResult.offers, "Amadeus");

    // "Apply Internal Filters" — non-stop / max-results, applied after
    // normalization so filtering logic is provider-independent.
    if (params.nonStop) {
      offers = offers.filter((o) => (o.segments || []).length <= 1);
    }
    if (params.maxResults) {
      offers = offers.slice(0, Math.max(1, parseInt(params.maxResults, 10) || offers.length));
    }

    const { searchCacheTtlSeconds } = getAmadeusHttpPolicy();
    await CacheManager.set(cacheKey, offers, searchCacheTtlSeconds);

    const durationMs = Date.now() - startedAt;
    AmadeusMetricsService.recordSearch(durationMs, true);
    publishEvent("FlightSearchCompleted", { correlationId, tenantId: params.tenantId, provider: "Amadeus", totalOffers: offers.length, latencyMs: durationMs, fromCache: false });

    return { offers, fromCache: false, correlationId, latencyMs: durationMs };
  }

  static getMetrics() {
    return AmadeusMetricsService.getSnapshot();
  }
}

export default AmadeusFlightSearchService;
