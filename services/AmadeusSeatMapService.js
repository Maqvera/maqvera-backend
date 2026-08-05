import mongoose from "mongoose";
import FlightBookingModel from "../models/FlightBookingModel.js";
import AuditLogModel from "../models/AuditLogmodel.js";
import GdsIntegrationService from "./GdsIntegrationService.js";
import CacheManager from "../utils/cacheManager.js";
import { throwStructured } from "./AmadeusFlightBookingService.js";
import { getSeatMapPolicy } from "../utils/gdsConfig.js";
import { publishEvent } from "../utils/eventBus.js";

const INACTIVE_BOOKING_STATUSES = ["Cancelled", "Expired", "Rejected", "Failed"];

/**
 * EXT-008 — Amadeus Seat Map API. Read-only: never stores seat inventory,
 * always sourced fresh from Amadeus (or an honestly-labeled dynamic-sandbox
 * fallback) and cached only for the doc's own 5-minute TTL.
 */
class AmadeusSeatMapService {
  static async getSeatMap({ tenantId, flightOrderId, travelerId, segmentId, requestId }) {
    // "Valid Flight Order ID".
    if (!flightOrderId || !String(flightOrderId).trim()) {
      throwStructured("A valid flightOrderId is required.", "INVALID_REQUEST", 400);
    }

    // "Flight Order Exists" / "Same Tenant" — looked up by the same
    // airlineOrderId EXT-004/EXT-006 already populate on every booking
    // (backfilled for the older API-006C path too, see FlightBookingController.js).
    const booking = await FlightBookingModel.findOne({
      tenantId,
      $or: [{ airlineOrderId: flightOrderId }, { providerBookingReference: flightOrderId }]
    });
    if (!booking) {
      throwStructured("Flight order not found for this tenant.", "FLIGHT_ORDER_NOT_FOUND", 404);
    }

    // "Booking Active".
    if (INACTIVE_BOOKING_STATUSES.includes(booking.status)) {
      throwStructured(`Cannot retrieve a seat map for a booking with status '${booking.status}'.`, "BOOKING_NOT_ACTIVE", 400);
    }

    const { cacheTtlSeconds, timeoutMs, maxRetries } = getSeatMapPolicy();
    const cacheKey = `seat-map:${flightOrderId}${travelerId ? `:${travelerId}` : ""}${segmentId ? `:${segmentId}` : ""}`;

    const cached = await CacheManager.get(cacheKey);
    if (cached) {
      publishEvent("SeatMapViewed", { flightOrderId, tenantId, fromCache: true });
      return cached;
    }

    // "Amadeus Connected".
    if (!GdsIntegrationService.circuitBreaker.canAttempt("Amadeus")) {
      throwStructured("Amadeus is currently unavailable (circuit breaker open).", "PROVIDER_UNAVAILABLE", 503);
    }

    let seatMap;
    try {
      seatMap = await GdsIntegrationService.getFlightOrderSeatMap({
        provider: "Amadeus",
        flightOrderId,
        bookingSnapshot: booking.bookingSnapshot,
        travelerId,
        segmentId,
        timeoutMs,
        maxRetries
      });
    } catch (err) {
      const code = err.code || (err.status === 429 ? "RATE_LIMIT_EXCEEDED" : err.status === 504 ? "PROVIDER_TIMEOUT" : err.status === 404 ? "SEAT_MAP_NOT_AVAILABLE" : err.status === 400 ? "AIRLINE_SEAT_SELECTION_UNSUPPORTED" : "PROVIDER_UNAVAILABLE");
      const status = code === "RATE_LIMIT_EXCEEDED" ? 429 : code === "PROVIDER_TIMEOUT" ? 504 : code === "SEAT_MAP_NOT_AVAILABLE" ? 404 : code === "AIRLINE_SEAT_SELECTION_UNSUPPORTED" ? 400 : 503;
      if (mongoose.connection?.readyState === 1) {
        AuditLogModel.create({
          tenantId, action: "AMADEUS_SEAT_MAP_FAILED", module: "ExternalIntegrations",
          requestId, targetId: booking._id.toString(), details: { flightOrderId, code, reason: err.message }
        }).catch((auditErr) => console.error("Seat map failure audit log error:", auditErr));
      }
      throwStructured(code === "SEAT_MAP_NOT_AVAILABLE" ? "Seat map is not available for this flight order." : err.message, code, status);
    }

    // Optional query filter — "Support multi-segment flights" while still
    // letting a caller narrow to one segment.
    if (segmentId) {
      seatMap.segments = seatMap.segments.filter((s) => s.segmentId === segmentId);
    }

    const responseData = { flightOrderId, segments: seatMap.segments };

    // "Seat map is never stored permanently" — this cache entry is a
    // short-lived read-through cache (TTL below), not persistence; nothing
    // in this codebase ever reads it back except this same lookup.
    await CacheManager.set(cacheKey, responseData, cacheTtlSeconds);

    publishEvent("SeatMapViewed", { flightOrderId, tenantId, source: seatMap._source || "unknown", fromCache: false });

    if (mongoose.connection?.readyState === 1) {
      AuditLogModel.create({
        tenantId, action: "AMADEUS_SEAT_MAP_VIEWED", module: "ExternalIntegrations",
        requestId, targetId: booking._id.toString(), details: { flightOrderId, source: seatMap._source || "unknown", travelerId: travelerId || null, segmentId: segmentId || null }
      }).catch((err) => console.error("Seat map audit log error:", err));
    }

    return responseData;
  }
}

export default AmadeusSeatMapService;
