import mongoose from "mongoose";
import AuditLogModel from "../models/AuditLogmodel.js";
import GdsIntegrationService from "./GdsIntegrationService.js";
import AmadeusAdapter from "./gds/AmadeusAdapter.js";
import CacheManager from "../utils/cacheManager.js";
import { throwStructured } from "./AmadeusFlightBookingService.js";
import { publishEvent } from "../utils/eventBus.js";
import { getHotelPricingPolicy, getFlightSearchValidationConfig } from "../utils/gdsConfig.js";

/**
 * EXT-021 — Amadeus Hotel Offer Pricing verification, the exact hotel-side
 * analog to EXT-003's flight pricing verification. This is the ONLY entry
 * point anything (including the AI Assistant, via its own
 * `verify_hotel_offer_pricing` tool) uses to re-confirm a hotel offer's
 * live price/availability before booking — never AmadeusAdapter directly.
 *
 * Reuses EXT-020's own `GdsIntegrationService.getHotelOfferById()` cache —
 * no second offer-tracking mechanism.
 */
class AmadeusHotelPricingService {
  static async verifyPricing({ tenantId, userId, hotelOfferId, currency, requestId }) {
    // §10 "Hotel Offer Exists".
    if (!hotelOfferId) {
      throwStructured("hotelOfferId is required.", "INVALID_REQUEST", 400);
    }

    // §10 "Currency Supported" — reuses the same supported-currency list
    // every other GDS-facing validation in this codebase already uses,
    // not a second hardcoded list.
    if (currency) {
      const { supportedCurrencies } = getFlightSearchValidationConfig();
      if (!supportedCurrencies.includes(String(currency).toUpperCase())) {
        throwStructured(`Unsupported currency "${currency}".`, "INVALID_REQUEST", 400);
      }
    }

    // "OAuth Active".
    if (!GdsIntegrationService.circuitBreaker.canAttempt("Amadeus")) {
      throwStructured("Amadeus is currently unavailable (circuit breaker open).", "PROVIDER_UNAVAILABLE", 503);
    }

    // §10 "Offer Not Expired" / §17 "Offer Expired" — reuses EXT-020's own
    // offer cache lookup, same pattern as EXT-016's flight branded-fares
    // reusing `revalidateOffer`.
    const cachedOffer = GdsIntegrationService.getHotelOfferById(hotelOfferId);
    if (!cachedOffer.isValid) {
      throwStructured("This hotel offer was not found or has expired. Please search again.", "OFFER_EXPIRED", 410);
    }
    const previousTotal = cachedOffer.rawOffer.price;

    const config = getHotelPricingPolicy();
    // §16 "Very short Redis cache (maximum 60 seconds) may be used only for
    // duplicate requests" — deliberately NOT the same long-lived cache
    // EXT-020 uses; this is a pre-booking re-verification step, not a
    // browsing cache, and every cache hit here is still a call that
    // happened within the last 60 seconds, not stale data being reused
    // across a booking session.
    const cacheKey = `gds:hotel-pricing:${hotelOfferId}`;

    let pricing;
    let fromCache = false;
    try {
      const cached = await CacheManager.get(cacheKey);
      if (cached) {
        pricing = cached;
        fromCache = true;
      } else if (cachedOffer.rawOfferSource === "live") {
        const realOfferId = cachedOffer.rawOffer._raw?.id;
        if (!realOfferId) {
          throwStructured("This hotel offer cannot be re-verified (missing provider offer reference).", "OFFER_EXPIRED", 410);
        }
        pricing = await GdsIntegrationService.getHotelOfferPricing({ provider: "Amadeus", offerId: realOfferId, timeoutMs: config.timeoutMs, maxRetries: config.maxRetries });
        await CacheManager.set(cacheKey, pricing, config.cacheTtlSeconds);
      } else {
        // No real Amadeus offer exists for this offer (it was a
        // dynamic-sandbox search result) — never fabricate a live
        // re-confirm call against an offer Amadeus never issued.
        pricing = AmadeusAdapter._buildDynamicSandboxHotelOfferPricing({
          hotelOfferId, basePrice: cachedOffer.rawOffer.basePrice || previousTotal, taxes: cachedOffer.rawOffer.taxesAndFees,
          currency: currency || cachedOffer.rawOffer.currency, refundable: cachedOffer.rawOffer.refundable, freeCancellationUntil: cachedOffer.rawOffer.freeCancellationUntil,
          cancellationPenaltyAmount: cachedOffer.rawOffer.cancellationPenaltyAmount
        });
        // Short-cached too, same duplicate-request dedup rule.
        await CacheManager.set(cacheKey, pricing, config.cacheTtlSeconds);
      }
    } catch (err) {
      const code = err.code || (err.status === 429 ? "RATE_LIMIT_EXCEEDED" : err.status === 504 ? "PROVIDER_TIMEOUT" : "PROVIDER_UNAVAILABLE");
      const status = err.status || (code === "RATE_LIMIT_EXCEEDED" ? 429 : code === "PROVIDER_TIMEOUT" ? 504 : 503);
      if (code === "OFFER_NOT_FOUND") {
        publishEvent("HotelOfferExpired", { tenantId, userId, hotelOfferId });
      }
      if (mongoose.connection?.readyState === 1) {
        AuditLogModel.create({
          tenantId, userId, action: "AMADEUS_HOTEL_PRICING_FAILED", module: "ExternalIntegrations",
          requestId, details: { hotelOfferId, code, reason: err.message }
        }).catch((auditErr) => console.error("Hotel pricing failure audit log error:", auditErr));
      }
      throwStructured(code === "OFFER_NOT_FOUND" ? "This room is no longer available. Please choose a different offer." : "Hotel pricing verification is temporarily unavailable. Please try again.", code, status);
    }

    // §9 "Compare Offer" / §14 "Detect price increases/decreases".
    const priceChanged = pricing.total != null && previousTotal != null && Math.round(pricing.total) !== Math.round(previousTotal);

    publishEvent("HotelPricingVerified", { tenantId, userId, hotelOfferId, status: pricing.status, source: pricing._source });
    if (!pricing.available || pricing.status === "Sold Out") {
      publishEvent("HotelOfferExpired", { tenantId, userId, hotelOfferId });
    } else if (priceChanged) {
      publishEvent("HotelPriceChanged", { tenantId, userId, hotelOfferId, previousTotal, currentTotal: pricing.total });
    } else {
      publishEvent("HotelOfferValidated", { tenantId, userId, hotelOfferId });
    }

    if (mongoose.connection?.readyState === 1) {
      AuditLogModel.create({
        tenantId, userId, action: "AMADEUS_HOTEL_PRICING_VERIFIED", module: "ExternalIntegrations",
        requestId, details: { hotelOfferId, status: pricing.status, previousTotal, currentTotal: pricing.total, priceChanged, source: pricing._source, fromCache }
      }).catch((err) => console.error("Hotel pricing audit log error:", err));
    }

    return {
      hotelOfferId: pricing.hotelOfferId, status: pricing.status, price: pricing.price, currency: pricing.currency,
      taxes: pricing.taxes, fees: pricing.fees, total: pricing.total, available: pricing.available,
      refundable: pricing.refundable, freeCancellationUntil: pricing.freeCancellationUntil,
      // EXT-024's real refund/penalty calculation reads this — see
      // AmadeusAdapter._normalizeHotelOfferEntry's own note.
      cancellationPenaltyAmount: pricing.cancellationPenaltyAmount ?? null,
      meta: { priceChanged, previousTotal, provider: "Amadeus", source: pricing._source, fromCache }
    };
  }
}

export default AmadeusHotelPricingService;
