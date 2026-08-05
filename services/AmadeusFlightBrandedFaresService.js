import mongoose from "mongoose";
import AuditLogModel from "../models/AuditLogmodel.js";
import GdsIntegrationService from "./GdsIntegrationService.js";
import AmadeusAdapter from "./gds/AmadeusAdapter.js";
import CacheManager from "../utils/cacheManager.js";
import { throwStructured } from "./AmadeusFlightBookingService.js";
import { publishEvent } from "../utils/eventBus.js";
import { getBrandedFaresPolicy } from "../utils/gdsConfig.js";

/**
 * EXT-016 — Amadeus Branded Fares (Flight Offers Upselling). This is the
 * ONLY entry point anything — including the AI Assistant's own
 * `compare_branded_fares` tool — uses to reach Amadeus's Upselling API;
 * never AmadeusAdapter directly, same layering every EXT-series AI tool
 * already follows.
 *
 * Reuses `GdsIntegrationService.revalidateOffer()` (built for EXT-004's
 * booking flow) as the offer lookup/expiry check §10 "Offer Not
 * Expired"/"Offer Not Found" needs — there is no second offer cache here.
 */
class AmadeusFlightBrandedFaresService {
  static async getBrandedFares({ tenantId, userId, flightOfferId, currency, passengers, requestId }) {
    // §10 "Flight Offer Required".
    if (!flightOfferId) {
      throwStructured("flightOfferId is required.", "INVALID_REQUEST", 400);
    }

    // "OAuth Active" — circuit breaker is the real proxy for provider connectivity.
    if (!GdsIntegrationService.circuitBreaker.canAttempt("Amadeus")) {
      throwStructured("Amadeus is currently unavailable (circuit breaker open).", "PROVIDER_UNAVAILABLE", 503);
    }

    // §10 "Offer Not Expired" / §17 "Offer Expired"/"Offer Not Found" — the
    // same cache-backed lookup EXT-004's booking creation already relies
    // on, re-checked on EVERY call (never skipped for a cache hit below),
    // so an expired underlying offer is always rejected before any stale
    // branded-fares cache entry could be served (§20 "Never Cache Expired
    // Offers").
    const revalidation = await GdsIntegrationService.revalidateOffer({ offerId: flightOfferId, tenantId, provider: "Amadeus" });
    if (!revalidation.isValid) {
      throwStructured("This flight offer was not found or has expired. Please search again.", "OFFER_EXPIRED", 410);
    }

    const config = getBrandedFaresPolicy();
    const cacheKey = `gds:branded-fares:${flightOfferId}`;

    let providerResult;
    let fromCache = false;
    try {
      const cached = await CacheManager.get(cacheKey);
      if (cached) {
        providerResult = cached;
        fromCache = true;
      } else if (revalidation.rawOfferSource === "live" && revalidation.rawOffer) {
        providerResult = await GdsIntegrationService.getBrandedFares({ provider: "Amadeus", rawFlightOffer: revalidation.rawOffer, timeoutMs: config.timeoutMs, maxRetries: config.maxRetries });
        await CacheManager.set(cacheKey, providerResult, config.cacheTtlSeconds);
      } else {
        // No real Amadeus offer object exists for this offer (it was a
        // dynamic-sandbox search result) — never fabricate a live upsell
        // call against an offer Amadeus never issued. Not cached either,
        // since it's already deterministic per offer.
        const cabin = "ECONOMY";
        providerResult = {
          provider: "Amadeus",
          fares: AmadeusAdapter._buildDynamicSandboxBrandedFares({ basePrice: revalidation.currentPrice || revalidation.originalPrice || 0, currency: revalidation.currency || config.fallbackCurrency, cabin }),
          _source: "dynamic-sandbox"
        };
      }
    } catch (err) {
      const code = err.code || (err.status === 429 ? "RATE_LIMIT_EXCEEDED" : err.status === 504 ? "PROVIDER_TIMEOUT" : "PROVIDER_UNAVAILABLE");
      const status = code === "RATE_LIMIT_EXCEEDED" ? 429 : code === "PROVIDER_TIMEOUT" ? 504 : 503;
      if (mongoose.connection?.readyState === 1) {
        AuditLogModel.create({
          tenantId, userId, action: "AMADEUS_BRANDED_FARES_FAILED", module: "ExternalIntegrations",
          requestId, details: { flightOfferId, code, reason: err.message }
        }).catch((auditErr) => console.error("Branded fares failure audit log error:", auditErr));
      }
      throwStructured("Branded fares are temporarily unavailable. Please try again.", code, status);
    }

    const fares = providerResult.fares || [];
    const comparison = AmadeusFlightBrandedFaresService._compareFares(fares);

    publishEvent("BrandedFareRetrieved", { tenantId, userId, flightOfferId, fareCount: fares.length, source: providerResult._source });
    if (fares.length > 1) publishEvent("FareCompared", { tenantId, flightOfferId, fareCount: fares.length });

    if (mongoose.connection?.readyState === 1) {
      AuditLogModel.create({
        tenantId, userId, action: "AMADEUS_BRANDED_FARES_VIEWED", module: "ExternalIntegrations",
        requestId, details: { flightOfferId, currency: currency || null, passengers: passengers || null, fareCount: fares.length, source: providerResult._source, fromCache }
      }).catch((err) => console.error("Branded fares audit log error:", err));
    }

    return { flightOfferId, fares, comparison, meta: { count: fares.length, provider: "Amadeus", source: providerResult._source, fromCache } };
  }

  /**
   * §9 "Apply Internal Rules" / §11 "Results ranked/compared". Real,
   * deterministic derivations over the fares actually returned — cheapest
   * and most-flexible (first fare with a confirmed `refund === "Allowed"`)
   * — not a fabricated "AI opinion". Persona-based reasoning ("best for
   * Umrah travelers", "best for business travelers") is deliberately left
   * to the AI Assistant tool layer (§14), which consumes this same real
   * data rather than this service re-implementing AI judgment.
   */
  static _compareFares(fares) {
    if (fares.length === 0) {
      return { cheapestFare: null, mostFlexibleFare: null };
    }
    const cheapest = fares.reduce((best, f) => (f.price != null && (best.price == null || f.price < best.price) ? f : best), fares[0]);
    const mostFlexible = fares.find((f) => f.refund === "Allowed") || null;
    return { cheapestFare: cheapest.fareName, mostFlexibleFare: mostFlexible ? mostFlexible.fareName : null };
  }

  /** §19 "FareRecommended" — published when a consumer (AI tool or booking UI) reports which fare it ultimately recommended/selected to a traveler. */
  static async recordRecommendation({ tenantId, userId, flightOfferId, fareName, requestId }) {
    if (!fareName) {
      throwStructured("fareName is required.", "INVALID_REQUEST", 400);
    }
    publishEvent("FareRecommended", { tenantId, userId, flightOfferId: flightOfferId || null, fareName });

    if (mongoose.connection?.readyState === 1) {
      AuditLogModel.create({ tenantId, userId, action: "BRANDED_FARE_RECOMMENDED", module: "ExternalIntegrations", requestId, details: { flightOfferId: flightOfferId || null, fareName } })
        .catch((err) => console.error("Fare recommendation audit log error:", err));
    }

    return { flightOfferId: flightOfferId || null, fareName };
  }
}

export default AmadeusFlightBrandedFaresService;
