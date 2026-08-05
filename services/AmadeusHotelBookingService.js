import mongoose from "mongoose";
import HotelBookingModel from "../models/HotelBookingModel.js";
import AuditLogModel from "../models/AuditLogmodel.js";
import GdsIntegrationService from "./GdsIntegrationService.js";
import AmadeusAdapter from "./gds/AmadeusAdapter.js";
import AmadeusHotelPricingService from "./AmadeusHotelPricingService.js";
import { throwStructured } from "./AmadeusFlightBookingService.js";
import { recordCanonicalDomainEvent } from "../controllers/TravelNotesTimelineController.js";
import { publishEvent } from "../utils/eventBus.js";
import { getHotelBookingPolicy } from "../utils/gdsConfig.js";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_PATTERN = /^\+?[0-9][0-9\s-]{6,14}[0-9]$/;

/**
 * EXT-022 — Amadeus Hotel Booking (real reservation creation). This is the
 * ONLY entry point anything — including the AI Assistant's own
 * `book_hotel_room` tool, which requires explicit human confirmation
 * before ever being invoked (§14) — uses to create a real Amadeus hotel
 * reservation; never AmadeusAdapter directly.
 *
 * Reuses EXT-020's offer cache (`GdsIntegrationService.getHotelOfferById`)
 * and EXT-021's pricing verification (`AmadeusHotelPricingService`)
 * directly — §11 "Booking allowed only after successful pricing
 * verification" is enforced structurally, not just documented, the same
 * way EXT-004's flight booking already calls EXT-003's pricing service
 * internally before ever creating a PNR.
 *
 * §"Important Architecture Note" — deliberately decoupled from Travel
 * Operations: unlike EXT-004 (which requires a pre-existing
 * TravelFlightAssignment), `travelPlanId` here is OPTIONAL. A hotel
 * reservation can be created standalone; Travel Operations attaching a
 * Hotel Assignment to it is a separate, future concern this document only
 * signals via `TravelPlanReadyForHotelAssignment` — it does not build that
 * consumer (§3 "Not Responsible For: Room Allocation, Operational
 * Management").
 */
class AmadeusHotelBookingService {
  static async createBooking({ tenantId, branchId, userId, userName, travelPlanId, hotelOfferId, guests, contact, specialRequests, currency, requestId }) {
    // §10 "Hotel Offer Valid".
    if (!hotelOfferId) {
      throwStructured("hotelOfferId is required.", "INVALID_REQUEST", 400);
    }

    // §10 "Guest Information Complete".
    if (!Array.isArray(guests) || guests.length === 0) {
      throwStructured("At least one guest is required.", "GUEST_VALIDATION_FAILED", 400);
    }
    for (const guest of guests) {
      if (!guest.firstName || !guest.lastName) {
        throwStructured("firstName and lastName are required for each guest.", "GUEST_VALIDATION_FAILED", 400);
      }
      if (guest.dateOfBirth) {
        const dob = new Date(guest.dateOfBirth);
        if (Number.isNaN(dob.getTime()) || dob > new Date()) {
          throwStructured(`dateOfBirth for ${guest.firstName} ${guest.lastName} is invalid.`, "GUEST_VALIDATION_FAILED", 400);
        }
      }
    }

    // §10 "Required Contact Information Present".
    if (!contact?.email && !contact?.phone) {
      throwStructured("At least a contact email or phone number is required.", "GUEST_VALIDATION_FAILED", 400);
    }
    if (contact?.email && !EMAIL_PATTERN.test(contact.email)) {
      throwStructured("Invalid contact email.", "GUEST_VALIDATION_FAILED", 400);
    }
    if (contact?.phone && !PHONE_PATTERN.test(contact.phone)) {
      throwStructured("Invalid contact phone.", "GUEST_VALIDATION_FAILED", 400);
    }

    // "OAuth Active".
    if (!GdsIntegrationService.circuitBreaker.canAttempt("Amadeus")) {
      throwStructured("Amadeus is currently unavailable (circuit breaker open).", "PROVIDER_UNAVAILABLE", 503);
    }

    // §11 "Booking allowed only after successful pricing verification" —
    // the SAME EXT-021 service the standalone pricing-verification
    // endpoint calls, not a re-implementation. Deliberately BEFORE the
    // duplicate-booking DB check below: this is a cheap, DB-free cache
    // lookup (via GdsIntegrationService.getHotelOfferById internally) that
    // correctly rejects a garbage/expired/never-searched offerId with
    // OFFER_EXPIRED before ever touching the database — a request that
    // can't possibly succeed shouldn't pay for a DB round-trip first.
    const pricing = await AmadeusHotelPricingService.verifyPricing({ tenantId, userId, hotelOfferId, currency, requestId });
    if (!pricing.available || pricing.status === "Sold Out") {
      throwStructured("This room is no longer available. Please choose a different offer.", "ROOM_NOT_AVAILABLE", 409);
    }
    if (pricing.meta.priceChanged) {
      // Same "never silently book at the stale price" pattern as EXT-004.
      return {
        booked: false, priceChanged: true,
        previousTotal: pricing.meta.previousTotal, newTotal: pricing.total, currency: pricing.currency,
        message: "Price changed since the offer was selected. Please confirm the new price and resubmit to book."
      };
    }

    // §11 "No duplicate booking allowed" — a second booking attempt for
    // the same (now confirmed-valid) offer returns the existing
    // reservation instead of creating a duplicate one at the provider.
    const existing = await HotelBookingModel.findOne({ tenantId, offerId: hotelOfferId, status: { $ne: "Cancelled" } });
    if (existing) {
      return { booked: true, alreadyBooked: true, bookingId: existing._id, provider: existing.provider, providerConfirmationNumber: existing.providerConfirmationNumber, status: existing.status, hotelName: existing.hotelName, roomType: existing.roomType, checkIn: existing.checkIn, checkOut: existing.checkOut };
    }

    // Re-fetch the cached offer for hotel/room details and the real
    // Amadeus offer ID (EXT-020's own cache, same lookup EXT-021 uses).
    const cachedOffer = GdsIntegrationService.getHotelOfferById(hotelOfferId);
    if (!cachedOffer.isValid) {
      throwStructured("This hotel offer was not found or has expired. Please search again.", "OFFER_EXPIRED", 410);
    }

    const config = getHotelBookingPolicy();
    let gdsResult;
    try {
      if (cachedOffer.rawOfferSource === "live") {
        const realOfferId = cachedOffer.rawOffer._raw?.id;
        if (!realOfferId) {
          throwStructured("This hotel offer cannot be booked (missing provider offer reference).", "OFFER_EXPIRED", 410);
        }
        const liveResult = await GdsIntegrationService.createHotelBookingReservation({ provider: "Amadeus", offerId: realOfferId, guests, contact, timeoutMs: config.timeoutMs, maxRetries: config.maxRetries });
        gdsResult = { provider: liveResult.provider, ...liveResult };
      } else {
        // No real Amadeus offer exists for this offer (dynamic-sandbox
        // search result) — never fabricate a live booking call against an
        // offer Amadeus never issued.
        gdsResult = { provider: "Amadeus", ...AmadeusAdapter._buildDynamicSandboxHotelBooking() };
      }
    } catch (err) {
      const code = err.code || (err.status === 429 ? "RATE_LIMIT_EXCEEDED" : err.status === 504 ? "PROVIDER_TIMEOUT" : "BOOKING_FAILED");
      const status = err.status || (code === "RATE_LIMIT_EXCEEDED" ? 429 : code === "PROVIDER_TIMEOUT" ? 504 : 502);
      if (mongoose.connection?.readyState === 1) {
        AuditLogModel.create({
          tenantId, userId, action: "AMADEUS_HOTEL_BOOKING_FAILED", module: "ExternalIntegrations",
          requestId, details: { hotelOfferId, code, reason: err.message }
        }).catch((auditErr) => console.error("Hotel booking failure audit log error:", auditErr));
      }
      throwStructured(code === "INVALID_PROVIDER_RESPONSE" ? err.message : "Hotel booking could not be completed. Please try again.", code, status);
    }

    const hotel = cachedOffer.hotel;
    const offer = cachedOffer.rawOffer;
    if (!offer?.checkInDate || !offer?.checkOutDate) {
      // EXT-020's own normalized offer always carries these (set directly
      // from the search request that produced it) — their absence means
      // the cached offer is malformed, not something worth guessing dates
      // for.
      throwStructured("This hotel offer is missing check-in/check-out dates and cannot be booked.", "OFFER_EXPIRED", 410);
    }
    const reservationNumber = `HB-${new Date().getFullYear()}-${String(Date.now()).slice(-6)}`;

    const hotelBooking = await HotelBookingModel.create({
      tenantId, branchId: branchId || "main",
      travelPlanId: travelPlanId || null,
      offerId: hotelOfferId,
      provider: gdsResult.provider || "Amadeus",
      reservationNumber,
      providerConfirmationNumber: gdsResult.providerConfirmationNumber,
      providerBookingId: gdsResult.providerBookingId,
      status: "Confirmed",
      hotelName: hotel?.hotelName || "Unknown Hotel",
      // Honestly null — neither EXT-020's Hotel Offers response nor this
      // cached offer carries a city NAME (only the hotelId, which is not
      // the same thing and must never be substituted in for it).
      city: null,
      stars: hotel?.rating || 5,
      roomType: offer?.roomType || "Standard Room",
      mealPlan: offer?.mealPlan || "Room Only",
      checkIn: new Date(offer.checkInDate),
      checkOut: new Date(offer.checkOutDate),
      roomsCount: 1,
      guestsCount: guests.length,
      guests: guests.map((g) => ({ firstName: g.firstName, lastName: g.lastName, dateOfBirth: g.dateOfBirth ? new Date(g.dateOfBirth) : null, isLeadGuest: false })),
      totalPrice: pricing.total,
      currency: pricing.currency,
      cancellationPolicy: pricing.refundable ? `Free cancellation until ${pricing.freeCancellationUntil}` : "Non-refundable",
      // EXT-024 needs structured data (not just the display string above)
      // to compute a real refund/penalty at cancellation time.
      refundable: pricing.refundable,
      freeCancellationUntilDate: pricing.freeCancellationUntil ? new Date(pricing.freeCancellationUntil) : null,
      cancellationPenaltyAmount: pricing.cancellationPenaltyAmount ?? null,
      contact,
      specialRequests: Array.isArray(specialRequests) ? specialRequests : [],
      // "Booking snapshot never edited" — set once here, at creation.
      bookingSnapshot: gdsResult._raw || null,
      version: 1,
      versionHistory: [{ version: 1, updatedBy: userId || "System", updatedAt: new Date(), changes: { action: "HOTEL_BOOKING_CREATED", providerConfirmationNumber: gdsResult.providerConfirmationNumber } }]
    });

    if (travelPlanId) {
      await recordCanonicalDomainEvent({
        travelPlanId, tenantId, sourceModule: "ExternalIntegrations",
        aggregateType: "HotelBooking", aggregateId: hotelBooking._id, eventType: "HotelBooked",
        title: `Hotel Reservation Confirmed: ${gdsResult.providerConfirmationNumber}`,
        description: `${hotelBooking.hotelName} (${hotelBooking.roomType}), ${guests.length} guest(s), confirmed via Amadeus.`,
        actor: { userId: userId || "System", name: userName || "Hotel Booking Service", role: "Ops Coordinator" }
      });
    }

    publishEvent("HotelBookingCreated", { hotelBookingId: hotelBooking._id, tenantId, travelPlanId: travelPlanId || null, providerConfirmationNumber: gdsResult.providerConfirmationNumber });
    publishEvent("HotelBookingConfirmed", { hotelBookingId: hotelBooking._id, tenantId, providerConfirmationNumber: gdsResult.providerConfirmationNumber });
    publishEvent("HotelReservationStored", { hotelBookingId: hotelBooking._id, tenantId, provider: gdsResult.provider });
    publishEvent("BookingSnapshotCreated", { hotelBookingId: hotelBooking._id, tenantId, hasRawSnapshot: Boolean(hotelBooking.bookingSnapshot) });
    // Only meaningful when a Travel Plan actually exists to be "ready" —
    // this doc's own decoupled design (§"Important Architecture Note")
    // means a standalone booking has nothing for Travel Operations to
    // attach yet.
    if (travelPlanId) {
      publishEvent("TravelPlanReadyForHotelAssignment", { hotelBookingId: hotelBooking._id, travelPlanId, tenantId });
    }

    if (mongoose.connection?.readyState === 1) {
      AuditLogModel.create({
        tenantId, userId, action: "AMADEUS_HOTEL_BOOKING_CREATED", module: "ExternalIntegrations",
        requestId, branchId, targetId: hotelBooking._id.toString(),
        details: { provider: gdsResult.provider, providerConfirmationNumber: gdsResult.providerConfirmationNumber, hotelOfferId, travelPlanId: travelPlanId || null }
      }).catch((err) => console.error("Hotel booking audit log error:", err));
    }

    return {
      booked: true,
      bookingId: hotelBooking._id,
      provider: hotelBooking.provider,
      providerConfirmationNumber: hotelBooking.providerConfirmationNumber,
      status: hotelBooking.status,
      hotelName: hotelBooking.hotelName,
      roomType: hotelBooking.roomType,
      checkIn: hotelBooking.checkIn,
      checkOut: hotelBooking.checkOut
    };
  }
}

export default AmadeusHotelBookingService;
