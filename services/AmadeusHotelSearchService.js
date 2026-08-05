import mongoose from "mongoose";
import AuditLogModel from "../models/AuditLogmodel.js";
import GdsIntegrationService from "./GdsIntegrationService.js";
import ReferenceDataService from "./ReferenceDataService.js";
import CacheManager from "../utils/cacheManager.js";
import { throwStructured } from "./AmadeusFlightBookingService.js";
import { publishEvent } from "../utils/eventBus.js";
import { getHotelListSearchPolicy } from "../utils/gdsConfig.js";

const CITY_CODE_PATTERN = /^[A-Z]{3}$/;

/**
 * EXT-019 — Amadeus Hotel Search (discovery). Same "AI never touches
 * Amadeus directly" layering every EXT-series AI tool in this codebase
 * follows — the `search_hotels` AI tool calls this service only.
 */
class AmadeusHotelSearchService {
  static async getHotels({ tenantId, userId, cityCode, latitude, longitude, radius, radiusUnit, hotelName, amenities, ratings, chainCode, page, pageSize, requestId }) {
    // §10 "City Code Required OR Latitude + Longitude Required".
    const hasCityCode = Boolean(cityCode);
    const hasGeo = latitude !== undefined && latitude !== null && latitude !== "" && longitude !== undefined && longitude !== null && longitude !== "";
    if (!hasCityCode && !hasGeo) {
      throwStructured("Either cityCode, or both latitude and longitude, are required.", "INVALID_REQUEST", 400);
    }
    let resolvedCityCode = null;
    if (hasCityCode) {
      resolvedCityCode = String(cityCode).toUpperCase();
      if (!CITY_CODE_PATTERN.test(resolvedCityCode)) {
        throwStructured("cityCode must be a valid 3-letter IATA city code.", "INVALID_REQUEST", 400);
      }
    }
    let resolvedLat = null, resolvedLng = null;
    if (hasGeo) {
      resolvedLat = Number.parseFloat(latitude);
      resolvedLng = Number.parseFloat(longitude);
      if (!Number.isFinite(resolvedLat) || resolvedLat < -90 || resolvedLat > 90 || !Number.isFinite(resolvedLng) || resolvedLng < -180 || resolvedLng > 180) {
        throwStructured("latitude/longitude must be valid coordinates.", "INVALID_REQUEST", 400);
      }
    }

    // §10 "Maximum Page Size = 100".
    const config = getHotelListSearchPolicy();
    const resolvedPage = Math.max(1, Number.parseInt(page, 10) || 1);
    const resolvedPageSize = Math.max(1, Math.min(config.maxPageSize, Number.parseInt(pageSize, 10) || config.defaultPageSize));

    const resolvedRatings = Array.isArray(ratings) ? ratings.map((r) => Number.parseInt(r, 10)).filter((r) => Number.isFinite(r) && r >= 1 && r <= 5) : (ratings ? [Number.parseInt(ratings, 10)].filter(Number.isFinite) : []);
    const resolvedAmenities = Array.isArray(amenities) ? amenities : (amenities ? [amenities] : []);
    const resolvedChainCode = chainCode ? String(chainCode).toUpperCase() : null;

    // "OAuth Active".
    if (!GdsIntegrationService.circuitBreaker.canAttempt("Amadeus")) {
      throwStructured("Amadeus is currently unavailable (circuit breaker open).", "PROVIDER_UNAVAILABLE", 503);
    }

    const cacheKey = `gds:hotel-list:${resolvedCityCode || `${resolvedLat},${resolvedLng},${radius || 5}${radiusUnit || "KM"}`}:${resolvedChainCode || "any"}:${resolvedRatings.join(",") || "any"}:${resolvedAmenities.join(",") || "any"}`;

    let providerResult;
    let fromCache = false;
    try {
      const cached = await CacheManager.get(cacheKey);
      if (cached) {
        providerResult = cached;
        fromCache = true;
      } else {
        providerResult = await GdsIntegrationService.searchHotelList({
          provider: "Amadeus", cityCode: resolvedCityCode, latitude: resolvedLat, longitude: resolvedLng, radius, radiusUnit,
          chainCode: resolvedChainCode, ratings: resolvedRatings, amenities: resolvedAmenities,
          timeoutMs: config.timeoutMs, maxRetries: config.maxRetries
        });
        await CacheManager.set(cacheKey, providerResult, config.cacheTtlSeconds);
      }
    } catch (err) {
      const code = err.code || (err.status === 429 ? "RATE_LIMIT_EXCEEDED" : err.status === 504 ? "PROVIDER_TIMEOUT" : "PROVIDER_UNAVAILABLE");
      const status = code === "RATE_LIMIT_EXCEEDED" ? 429 : code === "PROVIDER_TIMEOUT" ? 504 : 503;
      if (mongoose.connection?.readyState === 1) {
        AuditLogModel.create({
          tenantId, userId, action: "AMADEUS_HOTEL_SEARCH_FAILED", module: "ExternalIntegrations",
          requestId, details: { cityCode: resolvedCityCode, latitude: resolvedLat, longitude: resolvedLng, code, reason: err.message }
        }).catch((auditErr) => console.error("Hotel search failure audit log error:", auditErr));
      }
      throwStructured("Hotel search is temporarily unavailable. Please try again.", code, status);
    }

    let hotels = providerResult.hotels || [];

    // §11 "Read-only integration" business filter — hotelName has no
    // confirmed real Amadeus query parameter on this endpoint, so it's
    // applied client-side over the real results instead of guessed at as
    // a provider param.
    if (hotelName) {
      const needle = String(hotelName).toLowerCase();
      hotels = hotels.filter((h) => h.hotelName && h.hotelName.toLowerCase().includes(needle));
    }

    hotels = await AmadeusHotelSearchService._enrichWithReferenceData(hotels);

    const total = hotels.length;
    const start = (resolvedPage - 1) * resolvedPageSize;
    // Amadeus's real Hotel List endpoint has no page/pageSize parameters of
    // its own — pagination here is an honest client-side slice over the
    // full result set actually returned, not a provider-level feature.
    const pageItems = hotels.slice(start, start + resolvedPageSize);

    publishEvent("HotelSearchPerformed", { tenantId, userId, cityCode: resolvedCityCode, resultCount: total, source: providerResult._source });

    if (mongoose.connection?.readyState === 1) {
      AuditLogModel.create({
        tenantId, userId, action: "AMADEUS_HOTEL_SEARCH_VIEWED", module: "ExternalIntegrations",
        requestId, details: { cityCode: resolvedCityCode, latitude: resolvedLat, longitude: resolvedLng, resultCount: total, source: providerResult._source, fromCache }
      }).catch((err) => console.error("Hotel search audit log error:", err));
    }

    return { hotels: pageItems, meta: { count: pageItems.length, total, page: resolvedPage, pageSize: resolvedPageSize, provider: "Amadeus", source: providerResult._source, fromCache } };
  }

  /**
   * Enriches each hotel's city/country using EXT-013's own synchronized
   * reference data (real, already-synced airport/city master records —
   * Amadeus hotel city codes ARE IATA city codes) rather than parsing
   * anything from the hotel response itself, which doesn't carry a city
   * name. A city outside the local reference seed list honestly resolves
   * to `city: null, country: null`, never guessed.
   */
  static async _enrichWithReferenceData(hotels) {
    const distinctCodes = [...new Set(hotels.map((h) => h.cityCode).filter(Boolean))];
    if (distinctCodes.length === 0) return hotels;

    const lookups = await Promise.all(distinctCodes.map(async (code) => {
      const { items } = await ReferenceDataService.getCities({ code, limit: 1 });
      return [code, items[0] || null];
    }));
    const cityMap = new Map(lookups);

    return hotels.map((h) => {
      const cityEntry = h.cityCode ? cityMap.get(h.cityCode) : null;
      return { ...h, city: cityEntry?.cityName || h.city, country: cityEntry?.country || h.country };
    });
  }

  /** §19 "HotelViewed" — consumer-driven (a traveler opening a specific hotel's details is a frontend action this discovery endpoint can't know about), same minimal-feedback-endpoint pattern as EXT-014 through EXT-017. */
  static async recordHotelViewed({ tenantId, userId, hotelId, requestId }) {
    if (!hotelId) {
      throwStructured("hotelId is required.", "INVALID_REQUEST", 400);
    }
    publishEvent("HotelViewed", { tenantId, userId, hotelId });

    if (mongoose.connection?.readyState === 1) {
      AuditLogModel.create({ tenantId, userId, action: "HOTEL_VIEWED", module: "ExternalIntegrations", requestId, details: { hotelId } })
        .catch((err) => console.error("Hotel viewed audit log error:", err));
    }

    return { hotelId };
  }
}

export default AmadeusHotelSearchService;
