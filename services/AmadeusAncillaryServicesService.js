import mongoose from "mongoose";
import AuditLogModel from "../models/AuditLogmodel.js";
import GdsIntegrationService from "./GdsIntegrationService.js";
import AmadeusAdapter from "./gds/AmadeusAdapter.js";
import CacheManager from "../utils/cacheManager.js";
import { throwStructured } from "./AmadeusFlightBookingService.js";
import { publishEvent } from "../utils/eventBus.js";
import { getAncillaryServicesPolicy } from "../utils/gdsConfig.js";

/**
 * EXT-017 — Amadeus Ancillary Services. Same "AI never touches Amadeus
 * directly" layering every EXT-series AI tool follows in this codebase —
 * the `recommend_ancillary_services` AI tool calls this service only.
 *
 * Reuses `GdsIntegrationService.revalidateOffer()` for offer lookup/expiry
 * (§10 "Offer Not Expired") — same pattern EXT-016 already established,
 * no second offer cache.
 */
class AmadeusAncillaryServicesService {
  static async getAncillaries({ tenantId, userId, flightOfferId, currency, passengers, requestId }) {
    // §10 "Flight Offer Exists".
    if (!flightOfferId) {
      throwStructured("flightOfferId is required.", "INVALID_REQUEST", 400);
    }

    // §10 "Passenger Count Valid" — only enforced when explicitly supplied;
    // otherwise the offer's own already-known passenger count (from the
    // original search) governs.
    let resolvedPassengers = null;
    if (passengers !== undefined && passengers !== null && passengers !== "") {
      resolvedPassengers = Number.parseInt(passengers, 10);
      if (!Number.isFinite(resolvedPassengers) || resolvedPassengers <= 0) {
        throwStructured("passengers must be a positive integer.", "INVALID_REQUEST", 400);
      }
    }

    // "OAuth Active".
    if (!GdsIntegrationService.circuitBreaker.canAttempt("Amadeus")) {
      throwStructured("Amadeus is currently unavailable (circuit breaker open).", "PROVIDER_UNAVAILABLE", 503);
    }

    // §10 "Offer Not Expired" / §17 "Offer Expired" — re-checked on every
    // call, cache hit or not, so an expired offer never serves a stale
    // cached ancillary list.
    const revalidation = await GdsIntegrationService.revalidateOffer({ offerId: flightOfferId, tenantId, provider: "Amadeus" });
    if (!revalidation.isValid) {
      throwStructured("This flight offer was not found or has expired. Please search again.", "OFFER_EXPIRED", 410);
    }
    if (resolvedPassengers && resolvedPassengers > revalidation.requestedPassengers) {
      throwStructured(`passengers (${resolvedPassengers}) exceeds the ${revalidation.requestedPassengers} passenger(s) on this offer.`, "INVALID_REQUEST", 400);
    }

    const config = getAncillaryServicesPolicy();
    const cacheKey = `gds:ancillary-services:${flightOfferId}`;

    let providerResult;
    let fromCache = false;
    try {
      const cached = await CacheManager.get(cacheKey);
      if (cached) {
        providerResult = cached;
        fromCache = true;
      } else if (revalidation.rawOfferSource === "live" && revalidation.rawOffer) {
        providerResult = await GdsIntegrationService.getAncillaryServices({ provider: "Amadeus", rawFlightOffer: revalidation.rawOffer, timeoutMs: config.timeoutMs, maxRetries: config.maxRetries });
        await CacheManager.set(cacheKey, providerResult, config.cacheTtlSeconds);
      } else {
        // No real Amadeus offer object exists for this offer (dynamic-
        // sandbox search result) — never fabricate a live ancillary call
        // against an offer Amadeus never issued.
        providerResult = { provider: "Amadeus", services: AmadeusAdapter._buildDynamicSandboxAncillaryServices({ currency: revalidation.currency || currency || "USD" }), _source: "dynamic-sandbox" };
      }
    } catch (err) {
      const code = err.code || (err.status === 429 ? "RATE_LIMIT_EXCEEDED" : err.status === 504 ? "PROVIDER_TIMEOUT" : "PROVIDER_UNAVAILABLE");
      const status = code === "RATE_LIMIT_EXCEEDED" ? 429 : code === "PROVIDER_TIMEOUT" ? 504 : 503;
      if (mongoose.connection?.readyState === 1) {
        AuditLogModel.create({
          tenantId, userId, action: "AMADEUS_ANCILLARY_SERVICES_FAILED", module: "ExternalIntegrations",
          requestId, details: { flightOfferId, code, reason: err.message }
        }).catch((auditErr) => console.error("Ancillary services failure audit log error:", auditErr));
      }
      throwStructured("Ancillary services are temporarily unavailable. Please try again.", code, status);
    }

    // §11 "Ancillary availability depends on airline" — an empty list is a
    // normal, valid outcome (§17 "Ancillary Not Available" is a state, not
    // necessarily a hard error), never backfilled with invented services.
    const services = providerResult.services || [];

    publishEvent("AncillaryServicesRetrieved", { tenantId, userId, flightOfferId, serviceCount: services.length, source: providerResult._source });

    if (mongoose.connection?.readyState === 1) {
      AuditLogModel.create({
        tenantId, userId, action: "AMADEUS_ANCILLARY_SERVICES_VIEWED", module: "ExternalIntegrations",
        requestId, details: { flightOfferId, currency: currency || null, passengers: resolvedPassengers, serviceCount: services.length, source: providerResult._source, fromCache }
      }).catch((err) => console.error("Ancillary services audit log error:", err));
    }

    return { flightOfferId, services, meta: { count: services.length, provider: "Amadeus", source: providerResult._source, fromCache } };
  }

  /**
   * §19 "AncillarySelected"/"BookingPriceUpdated" — consumer-driven (a
   * traveler picking specific add-ons is a frontend/booking-flow action
   * this discovery endpoint can't know about by itself), same minimal-
   * feedback-endpoint pattern as EXT-014/015/016's own selection/feedback
   * endpoints.
   */
  static async recordSelection({ tenantId, userId, flightOfferId, selectedServiceIds, currency, requestId }) {
    if (!flightOfferId || !Array.isArray(selectedServiceIds) || selectedServiceIds.length === 0) {
      throwStructured("flightOfferId and a non-empty selectedServiceIds array are required.", "INVALID_REQUEST", 400);
    }

    publishEvent("AncillarySelected", { tenantId, userId, flightOfferId, selectedServiceIds });
    publishEvent("BookingPriceUpdated", { tenantId, userId, flightOfferId, reason: "ancillary_selection", selectedServiceIds });

    if (mongoose.connection?.readyState === 1) {
      AuditLogModel.create({ tenantId, userId, action: "ANCILLARY_SERVICES_SELECTED", module: "ExternalIntegrations", requestId, details: { flightOfferId, selectedServiceIds, currency: currency || null } })
        .catch((err) => console.error("Ancillary selection audit log error:", err));
    }

    return { flightOfferId, selectedServiceIds };
  }
}

export default AmadeusAncillaryServicesService;
