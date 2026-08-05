import mongoose from "mongoose";
import GdsIntegrationService from "./GdsIntegrationService.js";
import AuditLogModel from "../models/AuditLogmodel.js";
import { getAmadeusPricingPolicy } from "../utils/gdsConfig.js";
import { publishEvent } from "../utils/eventBus.js";

const REQUIRED_OFFER_FIELDS = ["providerOfferId", "totalPrice", "currency", "rawProviderData"];

const throwStructured = (message, code, status) => {
  const err = new Error(message);
  err.code = code;
  err.status = status;
  throw err;
};

/**
 * EXT-003 — Amadeus Flight Pricing API. "Always validate live pricing.
 * Never trust cached prices." — this service never reads or writes any
 * cache (CacheManager or the in-memory searchCache both EXT-002 and
 * API-006B use); every call is a fresh round trip (or an honestly-labeled
 * dynamic re-price simulation when no live credentials exist).
 */
class AmadeusFlightPricingService {
  static async verifyPrice({ tenantId, userId, flightOffer, requestId }) {
    // Validation Rules §8: Flight Offer Required, Flight Offer Must Be Valid.
    if (!flightOffer || typeof flightOffer !== "object") {
      throwStructured("flightOffer is required.", "INVALID_FLIGHT_OFFER", 400);
    }
    if (flightOffer.provider !== "Amadeus") {
      throwStructured("flightOffer.provider must be 'Amadeus' — this endpoint only prices Amadeus offers.", "INVALID_FLIGHT_OFFER", 400);
    }
    const missing = REQUIRED_OFFER_FIELDS.filter((f) => flightOffer[f] === undefined || flightOffer[f] === null);
    if (missing.length > 0) {
      throwStructured(`flightOffer is missing required field(s): ${missing.join(", ")}. It must be exactly the object returned by EXT-002's search endpoint.`, "INVALID_FLIGHT_OFFER", 400);
    }

    const { timeoutMs, maxRetries, maxOfferAgeSeconds } = getAmadeusPricingPolicy();

    // Price Expiry Validation.
    if (flightOffer.searchedAt) {
      const ageSeconds = (Date.now() - new Date(flightOffer.searchedAt).getTime()) / 1000;
      if (!Number.isFinite(ageSeconds) || ageSeconds > maxOfferAgeSeconds) {
        throwStructured("This flight offer has expired. Please search again.", "INVALID_FLIGHT_OFFER", 409);
      }
    }

    // Circuit Breaker — shared with API-006B/EXT-002's search paths, since
    // they all call the literal same downstream Amadeus API.
    if (!GdsIntegrationService.circuitBreaker.canAttempt("Amadeus")) {
      throwStructured("Amadeus is currently unavailable (circuit breaker open).", "PROVIDER_UNAVAILABLE", 503);
    }

    const adapter = GdsIntegrationService.getAdapter("Amadeus");
    const startedAt = Date.now();
    let pricing;
    try {
      pricing = await adapter.getFlightOfferPricing(flightOffer.rawProviderData, { timeoutMs, maxRetries });
      GdsIntegrationService.circuitBreaker.recordSuccess("Amadeus");
    } catch (err) {
      GdsIntegrationService.circuitBreaker.recordFailure("Amadeus");
      const durationMs = Date.now() - startedAt;
      const code = err.code || (err.status === 429 ? "RATE_LIMIT_EXCEEDED" : err.status === 504 ? "PROVIDER_TIMEOUT" : err.status === 502 ? "PROVIDER_UNAVAILABLE" : "FLIGHT_NOT_AVAILABLE");
      const status = code === "RATE_LIMIT_EXCEEDED" ? 429 : code === "PROVIDER_TIMEOUT" ? 504 : code === "PROVIDER_UNAVAILABLE" ? 503 : 409;

      publishEvent("FlightPricingFailed", { tenantId, userId, providerOfferId: flightOffer.providerOfferId, code, durationMs });
      if (mongoose.connection?.readyState === 1) {
        AuditLogModel.create({
          tenantId, userId, action: "AMADEUS_FLIGHT_PRICING_FAILED", module: "ExternalIntegrations",
          requestId, details: { provider: "Amadeus", providerOfferId: flightOffer.providerOfferId, code, durationMs }
        }).catch((auditErr) => console.error("Pricing failure audit log error:", auditErr));
      }

      // §13/§18 "No Raw Provider Errors" — never forward err.message from
      // a raw fetch/JSON parse failure; only the already business-safe
      // message set on the structured error above.
      throwStructured(code === "FLIGHT_NOT_AVAILABLE" ? "Selected fare is no longer available." : err.message, code, status);
    }

    const durationMs = Date.now() - startedAt;
    const previousPrice = Number(flightOffer.totalPrice);
    const newPrice = Number(pricing.totalPrice);
    const priceChanged = Number.isFinite(newPrice) && Number.isFinite(previousPrice) && newPrice !== previousPrice;

    // §17 Logging: Tenant, User, Provider, Duration, Request ID, Price
    // Before, Price After, Currency, Response Code. Never log access tokens
    // (nothing here ever holds one).
    if (mongoose.connection?.readyState === 1) {
      AuditLogModel.create({
        tenantId, userId, action: "AMADEUS_FLIGHT_PRICING", module: "ExternalIntegrations",
        requestId, details: { provider: "Amadeus", providerOfferId: flightOffer.providerOfferId, priceBefore: previousPrice, priceAfter: newPrice, currency: pricing.currency, durationMs, priceChanged, responseCode: 200 }
      }).catch((err) => console.error("Pricing audit log error:", err));
    }

    if (priceChanged) {
      publishEvent("FlightPriceChanged", { tenantId, userId, providerOfferId: flightOffer.providerOfferId, previousPrice, newPrice, currency: pricing.currency });
    } else {
      publishEvent("FlightPriceVerified", { tenantId, userId, providerOfferId: flightOffer.providerOfferId, totalPrice: newPrice, currency: pricing.currency });
    }

    // §11/§12 — "currency returned by provider must be preserved" (pricing.currency, never the client's currency).
    const response = {
      priceVerified: true,
      priceChanged,
      currency: pricing.currency,
      baseFare: pricing.baseFare,
      taxes: pricing.taxes,
      totalPrice: newPrice,
      fareType: pricing.fareType,
      lastTicketingDate: pricing.lastTicketingDate,
      numberOfBookableSeats: pricing.numberOfBookableSeats
    };
    if (priceChanged) {
      response.previousPrice = previousPrice;
      response.newPrice = newPrice;
      response.message = "Price updated by airline.";
    }
    return response;
  }
}

export default AmadeusFlightPricingService;
