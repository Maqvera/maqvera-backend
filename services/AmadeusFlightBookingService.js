import mongoose from "mongoose";
import TravelPlanModel from "../models/TravelPlanModel.js";
import TravelFlightAssignmentModel from "../models/TravelFlightAssignmentModel.js";
import FlightBookingModel from "../models/FlightBookingModel.js";
import AuditLogModel from "../models/AuditLogmodel.js";
import GdsIntegrationService from "./GdsIntegrationService.js";
import AmadeusFlightPricingService from "./AmadeusFlightPricingService.js";
import { recordCanonicalDomainEvent } from "../controllers/TravelNotesTimelineController.js";
import { publishEvent } from "../utils/eventBus.js";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_PATTERN = /^\+?[0-9][0-9\s-]{6,14}[0-9]$/;

export const throwStructured = (message, code, status) => {
  const err = new Error(message);
  err.code = code;
  err.status = status;
  throw err;
};

// doc §15/§16 vocabulary → this codebase's existing FlightBookingModel enums.
// Exported so EXT-005's AmadeusFlightTicketingService shares the exact same
// mapping instead of a second, potentially drifting copy.
export const toDocBookingStatus = (internalStatus) => ({
  "Offer Selected": "Pending", "Pending Validation": "Pending", "Reserved": "Confirmed",
  "Awaiting Ticketing": "Confirmed", "Ticketed": "Confirmed", "Completed": "Confirmed",
  "Cancelled": "Cancelled", "Expired": "Expired", "Rejected": "Failed", "Failed": "Failed"
}[internalStatus] || "Pending");

export const toDocTicketStatus = (internalStatus) => ({
  "Not Issued": "Not Issued", "Issued": "Issued", "Voided": "Voided",
  "Reissued": "Exchanged", "Refund Requested": "Refunded", "Refunded": "Refunded"
}[internalStatus] || "Not Issued");

/**
 * EXT-004 — Amadeus Flight Booking API (PNR Create). Orchestration only:
 * "Travel Platform → Flight Booking Service → Amadeus Adapter → Amadeus
 * Flight Create Orders API → Airline Reservation System → PNR Created →
 * Booking Snapshot Saved → Travel Plan Updated." Reuses the already-proven
 * GdsIntegrationService.createFlightBooking (circuit breaker + retry) and
 * AmadeusFlightPricingService (EXT-003) rather than reimplementing either.
 */
class AmadeusFlightBookingService {
  static async createBooking({ tenantId, branchId, userId, userName, travelPlanId, flightAssignmentId, flightOffer, travelers, contact, requestId }) {
    // Validation Rules §10: Travel Plan Exists, Flight Assignment Exists,
    // Same Tenant.
    if (!travelPlanId || !flightAssignmentId) {
      throwStructured("travelPlanId and flightAssignmentId are required.", "INVALID_REQUEST", 400);
    }
    const travelPlan = await TravelPlanModel.findOne({ _id: travelPlanId, tenantId });
    if (!travelPlan) {
      throwStructured("Travel Plan not found for this tenant.", "INVALID_REQUEST", 404);
    }
    const flightAssignment = await TravelFlightAssignmentModel.findOne({ _id: flightAssignmentId, travelPlanId, tenantId });
    if (!flightAssignment) {
      throwStructured("Flight Assignment not found for this Travel Plan.", "INVALID_REQUEST", 404);
    }

    // "Flight Not Already Booked" — a Flight Assignment can only be booked
    // once; a second attempt returns the existing booking instead of
    // silently creating a duplicate airline reservation.
    if (flightAssignment.flightBookingId) {
      const existing = await FlightBookingModel.findOne({ _id: flightAssignment.flightBookingId, tenantId });
      if (existing && existing.status !== "Cancelled") {
        return {
          flightBookingId: existing._id,
          airlineOrderId: existing.airlineOrderId,
          pnr: existing.pnr,
          bookingStatus: toDocBookingStatus(existing.status),
          ticketStatus: toDocTicketStatus(existing.ticketStatus),
          alreadyBooked: true
        };
      }
    }

    if (!Array.isArray(travelers) || travelers.length === 0) {
      throwStructured("At least one traveler is required.", "TRAVELER_VALIDATION_FAILED", 400);
    }

    // "Traveler Exists / Traveler belongs to Travel Plan / Passport Valid /
    // Email Valid / Phone Valid."
    const knownTravelerIds = new Set((travelPlan.travelerSnapshots || []).map((t) => String(t.travelerId)));
    for (const traveler of travelers) {
      if (!traveler.firstName || !traveler.lastName || !traveler.passportNumber) {
        throwStructured("firstName, lastName, and passportNumber are required for each traveler.", "TRAVELER_VALIDATION_FAILED", 400);
      }
      if (traveler.travelerId && !knownTravelerIds.has(String(traveler.travelerId))) {
        throwStructured(`Traveler ${traveler.travelerId} does not belong to this Travel Plan.`, "TRAVELER_VALIDATION_FAILED", 400);
      }
      if (traveler.passportExpiry) {
        const expiry = new Date(traveler.passportExpiry);
        if (Number.isNaN(expiry.getTime()) || expiry <= new Date()) {
          throwStructured(`Passport for ${traveler.firstName} ${traveler.lastName} is expired or invalid.`, "PASSPORT_INVALID", 400);
        }
      }
      if (traveler.email && !EMAIL_PATTERN.test(traveler.email)) {
        throwStructured(`Invalid email for traveler ${traveler.firstName} ${traveler.lastName}.`, "TRAVELER_VALIDATION_FAILED", 400);
      }
      if (traveler.phone && !PHONE_PATTERN.test(traveler.phone)) {
        throwStructured(`Invalid phone number for traveler ${traveler.firstName} ${traveler.lastName}.`, "TRAVELER_VALIDATION_FAILED", 400);
      }
    }
    if (contact?.email && !EMAIL_PATTERN.test(contact.email)) {
      throwStructured("Invalid contact email.", "TRAVELER_VALIDATION_FAILED", 400);
    }
    if (contact?.phone && !PHONE_PATTERN.test(contact.phone)) {
      throwStructured("Invalid contact phone.", "TRAVELER_VALIDATION_FAILED", 400);
    }

    // "Verify Flight Pricing (EXT-003)" — a genuine workflow step, not a
    // formality: this endpoint calls the real pricing-verification service,
    // the same one EXT-003 exposes directly, before ever attempting to book.
    const pricing = await AmadeusFlightPricingService.verifyPrice({ tenantId, userId, flightOffer, requestId });
    if (pricing.priceChanged) {
      // "Price Changed → Return Latest Price" — never silently book at the
      // stale price; the caller must re-confirm and resubmit.
      return {
        booked: false,
        priceChanged: true,
        previousPrice: pricing.previousPrice,
        newPrice: pricing.newPrice,
        currency: pricing.currency,
        message: "Price changed since the offer was selected. Please confirm the new price and resubmit to book."
      };
    }

    const gdsResult = await GdsIntegrationService.createFlightBooking({
      tenantId,
      provider: "Amadeus",
      travelers,
      contact,
      totalPrice: pricing.totalPrice,
      currency: pricing.currency,
      rawFlightOffer: flightOffer.rawProviderData?.source === "dynamic-sandbox" ? null : flightOffer.rawProviderData
    });

    const ticketingDeadline = gdsResult.ticketingDeadline ? new Date(gdsResult.ticketingDeadline) : new Date(Date.now() + 24 * 60 * 60 * 1000);

    const flightBooking = await FlightBookingModel.create({
      tenantId, branchId,
      travelPlanId,
      flightAssignmentId,
      offerId: flightOffer.providerOfferId,
      provider: gdsResult.provider || "Amadeus",
      // EXT-010 — real carrier data already present on the flight offer
      // (FlightOfferMapper's Standard Flight DTO), never guessed.
      airlineCode: flightOffer.airlineCode || null,
      airlineName: flightOffer.airline || null,
      pnr: gdsResult.pnr,
      providerBookingReference: gdsResult.providerBookingReference || gdsResult.pnr,
      airlineOrderId: gdsResult.airlineOrderId || gdsResult.providerBookingReference || gdsResult.pnr,
      status: "Reserved",
      totalPrice: gdsResult.totalPrice || pricing.totalPrice,
      currency: gdsResult.currency || pricing.currency,
      ticketingDeadline,
      travelers: travelers.map((t, idx) => ({
        // Preserved so EXT-005's ticketing response can key `tickets[]` by
        // the same travelerId the Travel Plan already knows this person by
        // — previously dropped here, silently losing that linkage.
        travelerId: t.travelerId || null,
        firstName: t.firstName, lastName: t.lastName, gender: t.gender || "Male",
        dateOfBirth: t.dateOfBirth ? new Date(t.dateOfBirth) : null,
        passportNumber: t.passportNumber, passportExpiry: t.passportExpiry ? new Date(t.passportExpiry) : null,
        nationality: t.nationality || "PK"
      })),
      contact,
      // "Booking snapshot never edited" — set once here, at creation, and
      // never touched by any subsequent controller/service in this codebase.
      bookingSnapshot: gdsResult._raw || null,
      version: 1,
      versionHistory: [{ version: 1, updatedBy: userId || "System", updatedAt: new Date(), changes: { action: "PNR_CREATED", pnr: gdsResult.pnr, airlineOrderId: gdsResult.airlineOrderId } }]
    });

    // "Update Internal Flight Assignment."
    flightAssignment.flightBookingId = flightBooking._id;
    flightAssignment.airlinePNR = gdsResult.pnr;
    flightAssignment.externalOrderId = gdsResult.airlineOrderId || gdsResult.providerBookingReference;
    flightAssignment.bookingStatus = "Confirmed";
    flightAssignment.ticketStatus = "Not Issued";
    if (["scheduled"].includes(flightAssignment.status)) flightAssignment.status = "confirmed";
    flightAssignment.version = (flightAssignment.version || 1) + 1;
    flightAssignment.versionHistory.push({ version: flightAssignment.version, updatedBy: userId || "System", updatedAt: new Date(), changes: { action: "FLIGHT_BOOKED", pnr: gdsResult.pnr, flightBookingId: flightBooking._id.toString() } });
    await flightAssignment.save();

    await recordCanonicalDomainEvent({
      travelPlanId, tenantId,
      sourceModule: "ExternalIntegrations",
      aggregateType: "FlightBooking",
      aggregateId: flightBooking._id,
      eventType: "FlightBooked",
      title: `Flight PNR Created: ${gdsResult.pnr}`,
      description: `Airline reservation confirmed via Amadeus (Order ${flightAssignment.externalOrderId}) for ${travelers.length} traveler(s).`,
      actor: { userId: userId || "System", name: userName || "Flight Booking Service", role: "Ops Coordinator" }
    });

    publishEvent("FlightBookingCreated", { flightBookingId: flightBooking._id, pnr: gdsResult.pnr, tenantId, travelPlanId, flightAssignmentId });
    publishEvent("AirlinePNRCreated", { flightBookingId: flightBooking._id, pnr: gdsResult.pnr, airlineOrderId: flightAssignment.externalOrderId, tenantId });
    publishEvent("FlightBooked", { flightBookingId: flightBooking._id, travelPlanId, flightAssignmentId, pnr: gdsResult.pnr, tenantId });
    publishEvent("BookingSnapshotStored", { flightBookingId: flightBooking._id, tenantId, hasRawSnapshot: Boolean(flightBooking.bookingSnapshot) });

    if (mongoose.connection?.readyState === 1) {
      AuditLogModel.create({
        tenantId, userId, action: "AMADEUS_FLIGHT_BOOKING_CREATED", module: "ExternalIntegrations",
        requestId, branchId, targetId: flightBooking._id.toString(),
        details: { provider: "Amadeus", pnr: gdsResult.pnr, airlineOrderId: flightAssignment.externalOrderId, travelPlanId: travelPlanId.toString(), flightAssignmentId: flightAssignmentId.toString() }
      }).catch((err) => console.error("Flight booking audit log error:", err));
    }

    return {
      booked: true,
      flightBookingId: flightBooking._id,
      airlineOrderId: flightBooking.airlineOrderId,
      pnr: flightBooking.pnr,
      bookingStatus: toDocBookingStatus(flightBooking.status),
      ticketStatus: toDocTicketStatus(flightBooking.ticketStatus)
    };
  }
}

export default AmadeusFlightBookingService;
