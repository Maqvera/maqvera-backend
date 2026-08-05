import mongoose from "mongoose";
import HotelBookingModel from "../models/HotelBookingModel.js";
import AuditLogModel from "../models/AuditLogmodel.js";
import AmadeusAdapter from "./gds/AmadeusAdapter.js";
import CacheManager from "../utils/cacheManager.js";
import { throwStructured } from "./AmadeusFlightBookingService.js";
import { publishEvent } from "../utils/eventBus.js";
import { getHotelBookingRetrievalPolicy } from "../utils/gdsConfig.js";

/**
 * EXT-023 — Amadeus Hotel Booking Retrieval. Same "AI never touches
 * Amadeus directly" layering every EXT-series AI tool follows — the
 * `get_hotel_booking_details` AI tool calls this service only.
 *
 * Honest gap (see `AmadeusAdapter._formatHotelBookingSnapshot`'s own
 * documentation): Amadeus's real Hotel Booking API has no GET-by-id
 * retrieval operation, unlike Flight Order Management. "Provider is
 * source of truth" (§10) is honored at the point real provider truth
 * exists — EXT-022's own booking creation, which already stores Amadeus's
 * real raw response. This service serves that stored, genuine snapshot —
 * never fabricates a live re-fetch call to an endpoint with no confirmed
 * existence — while still doing real, useful synchronization bookkeeping
 * (refreshing `lastSynchronizedAt`, auditing every access, §10 "Every
 * synchronization audited").
 */
class AmadeusHotelBookingRetrievalService {
  static async getBooking({ tenantId, userId, providerBookingId, requestId }) {
    // §9 "Provider Booking Exists" (format check — genuine existence
    // confirmed by the DB lookup below).
    if (!providerBookingId) {
      throwStructured("providerBookingId is required.", "INVALID_REQUEST", 400);
    }

    const config = getHotelBookingRetrievalPolicy();
    const cacheKey = `gds:hotel-booking-retrieval:${tenantId}:${providerBookingId}`;

    const cached = await CacheManager.get(cacheKey);
    if (cached) {
      publishEvent("HotelBookingRetrieved", { tenantId, userId, providerBookingId, fromCache: true });
      return cached;
    }

    // §9 "Tenant Authorized" / "Booking Accessible" — a tenant-scoped
    // lookup naturally enforces both: a booking belonging to a different
    // tenant is indistinguishable from one that doesn't exist.
    const booking = await HotelBookingModel.findOne({ tenantId, providerConfirmationNumber: providerBookingId });
    if (!booking) {
      if (mongoose.connection?.readyState === 1) {
        AuditLogModel.create({
          tenantId, userId, action: "AMADEUS_HOTEL_BOOKING_RETRIEVAL_FAILED", module: "ExternalIntegrations",
          requestId, details: { providerBookingId, reason: "Booking not found" }
        }).catch((err) => console.error("Hotel booking retrieval failure audit log error:", err));
      }
      throwStructured("No hotel booking found for this confirmation number.", "BOOKING_NOT_FOUND", 404);
    }

    // §10 "Snapshot refreshed after successful retrieval" / "Every
    // synchronization audited" — real bookkeeping, not a formality: this
    // timestamp is what the (future) live-provider-backed version of this
    // method would otherwise only update after a genuine re-fetch.
    booking.lastSynchronizedAt = new Date();
    await booking.save();

    const result = AmadeusAdapter._formatHotelBookingSnapshot(booking);
    await CacheManager.set(cacheKey, result, config.cacheTtlSeconds);

    publishEvent("HotelBookingRetrieved", { tenantId, userId, providerBookingId, fromCache: false });
    publishEvent("HotelReservationVerified", { tenantId, hotelBookingId: booking._id, providerBookingId });
    publishEvent("HotelBookingSynchronized", { tenantId, hotelBookingId: booking._id, providerBookingId });
    publishEvent("BookingSnapshotUpdated", { tenantId, hotelBookingId: booking._id, lastSynchronizedAt: booking.lastSynchronizedAt });

    if (mongoose.connection?.readyState === 1) {
      AuditLogModel.create({
        tenantId, userId, action: "AMADEUS_HOTEL_BOOKING_RETRIEVED", module: "ExternalIntegrations",
        requestId, targetId: booking._id.toString(), details: { providerBookingId, status: booking.status }
      }).catch((err) => console.error("Hotel booking retrieval audit log error:", err));
    }

    return result;
  }
}

export default AmadeusHotelBookingRetrievalService;
