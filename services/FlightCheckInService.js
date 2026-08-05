import mongoose from "mongoose";
import FlightBookingModel from "../models/FlightBookingModel.js";
import TravelPlanModel from "../models/TravelPlanModel.js";
import TravelFlightAssignmentModel from "../models/TravelFlightAssignmentModel.js";
import AuditLogModel from "../models/AuditLogmodel.js";
import AirlineCheckInAdapterService from "./AirlineCheckInAdapterService.js";
import { saveBookingDocumentFile } from "../utils/fileStorage.js";
import { throwStructured } from "./AmadeusFlightBookingService.js";
import { recordCanonicalDomainEvent } from "../controllers/TravelNotesTimelineController.js";
import { publishEvent } from "../utils/eventBus.js";

const INACTIVE_BOOKING_STATUSES = ["Cancelled", "Expired", "Rejected", "Failed"];

const findBooking = (identifier, tenantId) => {
  const query = identifier.length === 24
    ? { _id: identifier, tenantId }
    : { pnr: identifier.toUpperCase(), tenantId };
  return FlightBookingModel.findOne(query);
};

/**
 * EXT-010 — Airline Flight Check-in API. The Travel Platform never performs
 * check-in itself: it either calls a tenant-configured, real airline-specific
 * check-in API, or honestly reports the airline as unsupported and returns
 * that airline's real web check-in portal instead. See
 * AirlineCheckInAdapterService for why there is no single "check-in SDK" to
 * install (unlike Amadeus's Self-Service catalog).
 */
class FlightCheckInService {
  static async checkIn({ tenantId, branchId, userId, userName, bookingId, travelerIds, requestId }) {
    // §9 request shape.
    if (!bookingId || !String(bookingId).trim()) {
      throwStructured("bookingId is required.", "INVALID_REQUEST", 400);
    }
    if (!Array.isArray(travelerIds) || travelerIds.length === 0) {
      throwStructured("At least one travelerId is required.", "INVALID_REQUEST", 400);
    }

    // "Booking Exists" / "Same Tenant".
    const booking = await findBooking(String(bookingId), tenantId);
    if (!booking) {
      throwStructured("Flight booking not found for this tenant.", "BOOKING_NOT_FOUND", 404);
    }

    // "Same Branch" — consistent with EXT-005/EXT-009's own convention.
    if (branchId && booking.branchId && booking.branchId !== branchId) {
      throwStructured("Flight booking belongs to a different branch.", "BRANCH_MISMATCH", 403);
    }

    if (INACTIVE_BOOKING_STATUSES.includes(booking.status)) {
      throwStructured(`Cannot check in a booking with status '${booking.status}'.`, "BOOKING_NOT_ACTIVE", 400);
    }

    // "Ticket Issued" — Business Rule "Check-in only after ticket issuance."
    if (!booking.ticketIssued) {
      throwStructured("Check-in is only available after tickets have been issued for this booking.", "TICKET_NOT_ISSUED", 400);
    }

    // "Traveler Exists" / "Traveler Belongs To Booking".
    const bookingTravelersById = new Map((booking.travelers || []).map((t) => [t.travelerId ? String(t.travelerId) : null, t]));
    for (const travelerId of travelerIds) {
      if (!bookingTravelersById.has(String(travelerId))) {
        throwStructured(`Traveler ${travelerId} does not belong to this booking.`, "TRAVELER_NOT_IN_BOOKING", 400);
      }
    }

    // "Determine Airline" — real data captured at booking creation time
    // (see FlightBookingController.js / AmadeusFlightBookingService.js);
    // never guessed here.
    if (!booking.airlineCode) {
      throwStructured("This booking has no recorded operating airline; check-in cannot be determined.", "AIRLINE_UNKNOWN", 422);
    }

    // "Check Integration Capability".
    const apiSupported = AirlineCheckInAdapterService.isApiSupported(booking.airlineCode);

    if (!apiSupported) {
      const { airlineName, checkInUrl } = AirlineCheckInAdapterService.getRedirectInfo(booking.airlineCode);
      if (mongoose.connection?.readyState === 1) {
        AuditLogModel.create({
          tenantId, userId, action: "AIRLINE_CHECKIN_UNSUPPORTED", module: "ExternalIntegrations",
          requestId, branchId, targetId: booking._id.toString(),
          details: { airlineCode: booking.airlineCode, travelerIds, executionTimeMs: 0 }
        }).catch((err) => console.error("Check-in (unsupported) audit log error:", err));
      }
      // §12 "Unsupported Airline Response" — a real, expected branch, not a
      // failure; no TravelerCheckedIn/BoardingPassGenerated/CheckInCompleted
      // event is published because none of those actually happened.
      return {
        supported: false,
        message: `Online check-in must be completed on ${airlineName}'s website.`,
        redirectUrl: checkInUrl
      };
    }

    // Already-checked-in travelers are a real idempotent no-op — skip
    // re-calling the airline for them.
    const pendingTravelerIds = travelerIds.filter((id) => bookingTravelersById.get(String(id)).checkInStatus !== "Checked In");
    const startedAt = Date.now();

    let apiResult = null;
    if (pendingTravelerIds.length > 0) {
      try {
        apiResult = await AirlineCheckInAdapterService.performCheckIn({ airlineCode: booking.airlineCode, pnr: booking.pnr, travelerIds: pendingTravelerIds });
      } catch (err) {
        publishEvent("CheckInFailed", { flightBookingId: booking._id, tenantId, airlineCode: booking.airlineCode, reason: err.message });
        if (mongoose.connection?.readyState === 1) {
          AuditLogModel.create({
            tenantId, userId, action: "AIRLINE_CHECKIN_FAILED", module: "ExternalIntegrations",
            requestId, branchId, targetId: booking._id.toString(),
            details: { airlineCode: booking.airlineCode, travelerIds: pendingTravelerIds, reason: err.message, executionTimeMs: Date.now() - startedAt }
          }).catch((auditErr) => console.error("Check-in failure audit log error:", auditErr));
        }
        throwStructured(err.status ? err.message : "Check-in failed. Please retry.", err.code || "PROVIDER_UNAVAILABLE", err.status || 503);
      }
    }

    const now = new Date();
    const apiTravelersById = new Map((apiResult?.travelers || []).map((t) => [String(t.travelerId), t]));
    const responseTravelers = [];

    for (const travelerId of travelerIds) {
      const traveler = bookingTravelersById.get(String(travelerId));

      if (traveler.checkInStatus === "Checked In") {
        responseTravelers.push({ travelerId, boardingStatus: "Checked In", seat: traveler.seatNumber || null });
        continue;
      }

      const apiTraveler = apiTravelersById.get(String(travelerId));
      traveler.checkInStatus = "Checked In";
      if (apiTraveler?.seat) traveler.seatNumber = apiTraveler.seat;

      // "Boarding pass files stored in Object Storage. Only metadata stored
      // in the database." Real object-storage upload, reusing the same
      // abstraction already used elsewhere in this codebase.
      if (apiTraveler?.boardingPassBase64) {
        const buffer = Buffer.from(apiTraveler.boardingPassBase64, "base64");
        const storageResult = await saveBookingDocumentFile({
          fileName: `boarding-pass-${booking.pnr}-${travelerId}`,
          mimeType: apiTraveler.mimeType || "application/pdf",
          buffer,
          extension: ".pdf"
        });
        booking.boardingPasses.push({
          travelerId, segmentId: apiTraveler.segmentId || null,
          fileName: storageResult.fileName, storedFileName: storageResult.storedFileName,
          storageProvider: storageResult.storageProvider, publicUrl: storageResult.publicUrl,
          mimeType: storageResult.mimeType, size: storageResult.size, issuedAt: now
        });
      } else if (apiTraveler?.boardingPassUrl) {
        booking.boardingPasses.push({
          travelerId, segmentId: apiTraveler.segmentId || null,
          fileName: `boarding-pass-${booking.pnr}-${travelerId}.pdf`, storedFileName: null,
          storageProvider: "external", publicUrl: apiTraveler.boardingPassUrl,
          mimeType: "application/pdf", size: 0, issuedAt: now
        });
      }

      responseTravelers.push({ travelerId, boardingStatus: "Checked In", seat: traveler.seatNumber || null });
      publishEvent("TravelerCheckedIn", { flightBookingId: booking._id, tenantId, travelerId, airlineCode: booking.airlineCode });
      if (apiTraveler?.boardingPassBase64 || apiTraveler?.boardingPassUrl) {
        publishEvent("BoardingPassGenerated", { flightBookingId: booking._id, tenantId, travelerId });
      }
    }

    // FlightBookingModel.status has no dedicated "checked in" value in its
    // existing enum (API-006D's Reserved/.../Ticketed/Completed lifecycle) —
    // per-traveler check-in state lives on `travelers[].checkInStatus`
    // instead; the booking's own `status` is left untouched here.
    booking.version = (booking.version || 1) + 1;
    booking.versionHistory.push({
      version: booking.version, updatedBy: userId || "System", updatedAt: now,
      changes: { action: "CHECKED_IN", travelerIds }
    });
    await booking.save();

    // Read-through sync onto Travel Operations — single-leg, same
    // documented limitation as EXT-009.
    if (booking.flightAssignmentId) {
      const flightAssignment = await TravelFlightAssignmentModel.findOne({ _id: booking.flightAssignmentId, tenantId });
      if (flightAssignment) {
        let touched = false;
        for (const travelerId of travelerIds) {
          const at = flightAssignment.assignedTravelers.find((t) => String(t.travelerId) === String(travelerId));
          if (at && at.checkInStatus !== "Checked In") { at.checkInStatus = "Checked In"; touched = true; }
        }
        if (touched) {
          if (flightAssignment.status === "confirmed" || flightAssignment.status === "ticket_issued") flightAssignment.status = "checked_in";
          flightAssignment.version = (flightAssignment.version || 1) + 1;
          flightAssignment.versionHistory.push({ version: flightAssignment.version, updatedBy: userId || "System", updatedAt: now, changes: { action: "CHECKED_IN", flightBookingId: booking._id.toString() } });
          await flightAssignment.save();
        }
      }
    }

    if (booking.travelPlanId) {
      await recordCanonicalDomainEvent({
        travelPlanId: booking.travelPlanId,
        tenantId,
        sourceModule: "ExternalIntegrations",
        aggregateType: "FlightBooking",
        aggregateId: booking._id,
        eventType: "CheckInCompleted",
        title: `Check-in Completed for PNR ${booking.pnr}`,
        description: `${travelerIds.length} traveler(s) checked in via ${booking.airlineName || booking.airlineCode}.`,
        actor: { userId: userId || "System", name: userName || "Check-in Service", role: "Ops Coordinator" }
      });
    }

    publishEvent("CheckInCompleted", { flightBookingId: booking._id, tenantId, airlineCode: booking.airlineCode, travelerIds });

    // "Notify Traveler" — no real Email/SMS/WhatsApp/Push provider exists in
    // this codebase; same honest pattern as EXT-005/EXT-009.
    for (const travelerId of travelerIds) {
      publishEvent("NotificationRequested", { tenantId, branchId, event: "CheckInCompleted", priority: "normal", channel: "Email", recipientId: travelerId, flightBookingId: booking._id });
    }

    if (mongoose.connection?.readyState === 1) {
      AuditLogModel.create({
        tenantId, userId, action: "AIRLINE_CHECKIN_COMPLETED", module: "ExternalIntegrations",
        requestId, branchId, targetId: booking._id.toString(),
        details: { airlineCode: booking.airlineCode, travelerIds, executionTimeMs: Date.now() - startedAt }
      }).catch((err) => console.error("Check-in audit log error:", err));
    }

    return {
      status: "Checked In",
      boardingPassAvailable: booking.boardingPasses.length > 0,
      travelers: responseTravelers
    };
  }
}

export default FlightCheckInService;
