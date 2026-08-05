import mongoose from "mongoose";
import AuditLogModel from "../models/AuditLogmodel.js";
import GdsIntegrationService from "./GdsIntegrationService.js";
import CacheManager from "../utils/cacheManager.js";
import { throwStructured } from "./AmadeusFlightBookingService.js";
import { publishEvent } from "../utils/eventBus.js";
import { getHotelOfferPolicy } from "../utils/gdsConfig.js";

const DATE_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

const toStartOfDay = (value) => {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
};

/**
 * EXT-020 — Amadeus Hotel Offers (room availability & pricing) for a
 * previously-discovered hotel (EXT-019). Same "AI never touches Amadeus
 * directly" layering every EXT-series AI tool follows — the
 * `get_hotel_room_offers` AI tool calls this service only.
 */
class AmadeusHotelOfferService {
  static async getOffers({ tenantId, userId, hotelId, checkInDate, checkOutDate, adults, children, rooms, currency, requestId }) {
    // §10 "Hotel Exists" — format validation only; genuine existence is
    // confirmed by the provider call itself (a real "not found" throws).
    if (!hotelId || typeof hotelId !== "string" || hotelId.trim().length === 0) {
      throwStructured("hotelId is required.", "INVALID_REQUEST", 400);
    }

    // §10 "Check-in Valid" / "Check-out After Check-in".
    if (!checkInDate || !DATE_ONLY_PATTERN.test(checkInDate) || Number.isNaN(new Date(checkInDate).getTime())) {
      throwStructured("checkInDate is required and must be a valid YYYY-MM-DD date.", "INVALID_REQUEST", 400);
    }
    if (!checkOutDate || !DATE_ONLY_PATTERN.test(checkOutDate) || Number.isNaN(new Date(checkOutDate).getTime())) {
      throwStructured("checkOutDate is required and must be a valid YYYY-MM-DD date.", "INVALID_REQUEST", 400);
    }
    const config = getHotelOfferPolicy();
    const today = toStartOfDay(new Date());
    const checkIn = toStartOfDay(checkInDate);
    const checkOut = toStartOfDay(checkOutDate);
    if (checkIn < today) {
      throwStructured("checkInDate cannot be in the past.", "INVALID_REQUEST", 400);
    }
    if (checkOut <= checkIn) {
      throwStructured("checkOutDate must be after checkInDate.", "INVALID_REQUEST", 400);
    }
    const maxDate = new Date(today.getTime() + config.maxAdvanceBookingDays * 86400000);
    if (checkIn > maxDate) {
      throwStructured(`checkInDate cannot be more than ${config.maxAdvanceBookingDays} days in the future.`, "INVALID_REQUEST", 400);
    }

    // §10 "Adult Count Valid" / "Room Count Positive".
    const resolvedAdults = adults !== undefined && adults !== null && adults !== "" ? Number.parseInt(adults, 10) : 1;
    if (!Number.isFinite(resolvedAdults) || resolvedAdults < 1 || resolvedAdults > config.maxAdults) {
      throwStructured(`adults must be a positive integer up to ${config.maxAdults}.`, "INVALID_REQUEST", 400);
    }
    const resolvedRooms = rooms !== undefined && rooms !== null && rooms !== "" ? Number.parseInt(rooms, 10) : 1;
    if (!Number.isFinite(resolvedRooms) || resolvedRooms < 1 || resolvedRooms > config.maxRooms) {
      throwStructured(`rooms must be a positive integer up to ${config.maxRooms}.`, "INVALID_REQUEST", 400);
    }

    // "OAuth Active".
    if (!GdsIntegrationService.circuitBreaker.canAttempt("Amadeus")) {
      throwStructured("Amadeus is currently unavailable (circuit breaker open).", "PROVIDER_UNAVAILABLE", 503);
    }

    const cacheKey = `gds:hotel-offers:${hotelId}:${checkInDate}:${checkOutDate}:${resolvedAdults}:${resolvedRooms}:${currency || "any"}`;

    let providerResult;
    let fromCache = false;
    try {
      const cached = await CacheManager.get(cacheKey);
      if (cached) {
        providerResult = cached;
        fromCache = true;
      } else {
        providerResult = await GdsIntegrationService.searchHotelOffers({
          provider: "Amadeus", hotelId, checkInDate, checkOutDate, adults: resolvedAdults, rooms: resolvedRooms, currency,
          timeoutMs: config.timeoutMs, maxRetries: config.maxRetries, cacheTtlSeconds: config.cacheTtlSeconds
        });
        // Cached separately from the per-offer hotelOfferCache above (that
        // one exists for offerId lookups; this is the whole search-result
        // cache, same two-tier shape every other EXT document uses).
        await CacheManager.set(cacheKey, providerResult, config.cacheTtlSeconds);
      }
    } catch (err) {
      const code = err.code || (err.status === 404 ? "HOTEL_NOT_FOUND" : err.status === 429 ? "RATE_LIMIT_EXCEEDED" : err.status === 504 ? "PROVIDER_TIMEOUT" : "PROVIDER_UNAVAILABLE");
      const status = code === "HOTEL_NOT_FOUND" ? 404 : code === "RATE_LIMIT_EXCEEDED" ? 429 : code === "PROVIDER_TIMEOUT" ? 504 : 503;
      if (mongoose.connection?.readyState === 1) {
        AuditLogModel.create({
          tenantId, userId, action: "AMADEUS_HOTEL_OFFERS_FAILED", module: "ExternalIntegrations",
          requestId, details: { hotelId, checkInDate, checkOutDate, code, reason: err.message }
        }).catch((auditErr) => console.error("Hotel offers failure audit log error:", auditErr));
      }
      throwStructured(code === "HOTEL_NOT_FOUND" ? err.message : "Hotel offers are temporarily unavailable. Please try again.", code, status);
    }

    // §17 "No Rooms Available" — a genuinely empty offers array is a
    // normal outcome, not an error (same "empty is valid" precedent as
    // EXT-017's ancillary services).
    const offers = providerResult.offers || [];

    publishEvent("HotelOffersRetrieved", { tenantId, userId, hotelId, offerCount: offers.length, source: providerResult._source });

    if (mongoose.connection?.readyState === 1) {
      AuditLogModel.create({
        tenantId, userId, action: "AMADEUS_HOTEL_OFFERS_VIEWED", module: "ExternalIntegrations",
        requestId, details: { hotelId, checkInDate, checkOutDate, adults: resolvedAdults, rooms: resolvedRooms, offerCount: offers.length, source: providerResult._source, fromCache }
      }).catch((err) => console.error("Hotel offers audit log error:", err));
    }

    return { hotelId, hotel: providerResult.hotel, offers, meta: { count: offers.length, provider: "Amadeus", source: providerResult._source, fromCache } };
  }

  /** §19 "RoomOfferViewed" — consumer-driven, same minimal-feedback-endpoint pattern as EXT-014 through EXT-019. */
  static async recordRoomViewed({ tenantId, userId, hotelId, offerId, requestId }) {
    if (!offerId) {
      throwStructured("offerId is required.", "INVALID_REQUEST", 400);
    }
    publishEvent("RoomOfferViewed", { tenantId, userId, hotelId: hotelId || null, offerId });

    if (mongoose.connection?.readyState === 1) {
      AuditLogModel.create({ tenantId, userId, action: "ROOM_OFFER_VIEWED", module: "ExternalIntegrations", requestId, details: { hotelId: hotelId || null, offerId } })
        .catch((err) => console.error("Room offer viewed audit log error:", err));
    }

    return { hotelId: hotelId || null, offerId };
  }
}

export default AmadeusHotelOfferService;
