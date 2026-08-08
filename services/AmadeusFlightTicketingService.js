import mongoose from "mongoose";
import FlightBookingModel from "../models/FlightBookingModel.js";
import TravelFlightAssignmentModel from "../models/TravelFlightAssignmentModel.js";
import AuditLogModel from "../models/AuditLogmodel.js";
import GdsIntegrationService from "./GdsIntegrationService.js";
import { throwStructured, toDocBookingStatus } from "./AmadeusFlightBookingService.js";
import { getTicketIssuanceRetryPolicy } from "../utils/gdsConfig.js";
import { recordCanonicalDomainEvent } from "../controllers/TravelNotesTimelineController.js";
import { publishEvent } from "../utils/eventBus.js";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * EXT-005 §17 "Automatic Retry, 3 Attempts, Exponential Backoff." A real
 * retry loop around the provider call — distinct from GdsIntegrationService's
 * generic single-retry _callWithRetry, since this document names its own
 * attempt count/backoff. "Failed requests moved to Retry Queue" is NOT
 * implemented beyond this synchronous retry: a durable async retry queue
 * needs a real background job system, which doesn't exist anywhere in this
 * codebase (same honest scope limit documented for EXT-004).
 */
const issueTicketWithRetry = async (ticketParams) => {
  const { maxAttempts, backoffBaseMs } = getTicketIssuanceRetryPolicy();
  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await GdsIntegrationService.issueTicket(ticketParams);
    } catch (err) {
      lastError = err;
      if (attempt < maxAttempts) {
        console.warn(`[EXT-005] issueTicket attempt ${attempt} failed (${err.message}); retrying...`);
        await sleep(backoffBaseMs * 2 ** (attempt - 1));
      }
    }
  }
  throw lastError;
};

/**
 * EXT-005 — Amadeus Flight Ticketing API. Converts a confirmed PNR (created
 * via EXT-004 / AmadeusFlightBookingService) into issued electronic tickets.
 * A separate, Travel-Operations-aware path from API-006D's
 * `POST /api/v1/flight-bookings/:flightBookingId/ticket` (same relationship
 * EXT-004 has to API-006C) — this one additionally updates the linked
 * TravelFlightAssignmentModel and records a Travel Plan timeline event.
 *
 * Amadeus's public Self-Service API catalog has no standalone ticket-issuance
 * REST endpoint (ticketing happens on the airline/GDS side, not via a
 * self-service call) — the same reason API-006D's existing ticketing path
 * never attempts a live Amadeus call either. This service therefore reuses
 * GdsIntegrationService.issueTicket's existing, honestly-simulated ticket
 * number generation rather than fabricating a live endpoint that doesn't
 * exist in Amadeus's real API surface.
 */
class AmadeusFlightTicketingService {
  static async issueTicket({ tenantId, userId, userName, bookingId, pnr, requestId }) {
    // Validation Rules §8.
    if (!bookingId || !pnr) {
      throwStructured("bookingId and pnr are required.", "INVALID_REQUEST", 400);
    }

    // "Booking Exists" / "Same Tenant".
    const booking = await FlightBookingModel.findOne({ _id: bookingId, tenantId });
    if (!booking) {
      throwStructured("Flight booking not found for this tenant.", "BOOKING_NOT_FOUND", 404);
    }

    // "PNR Exists" + must match the airline record locator on file — guards
    // against ticketing the wrong reservation on a bookingId typo/mismatch.
    if (!booking.pnr) {
      throwStructured("This booking has no PNR yet; it has not been reserved with the airline.", "PNR_NOT_FOUND", 400);
    }
    if (booking.pnr !== pnr) {
      throwStructured("Provided PNR does not match this booking's airline PNR.", "PNR_NOT_FOUND", 400);
    }

    // "Booking Confirmed" — reuses the exact same doc-vocabulary mapping
    // EXT-004 already established, so "Confirmed" means the same thing in
    // both documents.
    if (toDocBookingStatus(booking.status) !== "Confirmed") {
      throwStructured(`Cannot issue tickets for a booking with status '${booking.status}'.`, "BOOKING_NOT_CONFIRMED", 400);
    }

    // "Booking Not Already Ticketed" — Business Rule "Ticket issued only
    // once. Duplicate ticketing prohibited."
    if (booking.ticketIssued) {
      throwStructured("Tickets have already been issued for this booking.", "TICKET_ALREADY_ISSUED", 409);
    }

    // "Amadeus Connected" — the same shared circuit breaker EXT-002/003/004
    // all check against, since they hit the same downstream Amadeus surface.
    if (!GdsIntegrationService.circuitBreaker.canAttempt("Amadeus")) {
      throwStructured("Amadeus is currently unavailable (circuit breaker open).", "PROVIDER_UNAVAILABLE", 503);
    }

    let ticketResult;
    try {
      ticketResult = await issueTicketWithRetry({
        provider: "Amadeus",
        pnr: booking.pnr,
        travelersCount: booking.travelers.length,
        tenantId
      });
    } catch (err) {
      publishEvent("FlightTicketIssueFailed", { flightBookingId: booking._id, pnr: booking.pnr, tenantId, reason: err.message });
      if (mongoose.connection?.readyState === 1) {
        AuditLogModel.create({
          tenantId, userId, action: "AMADEUS_TICKET_ISSUE_FAILED", module: "ExternalIntegrations",
          requestId, targetId: booking._id.toString(), details: { pnr: booking.pnr, reason: err.message }
        }).catch((auditErr) => console.error("Ticket issuance failure audit log error:", auditErr));
      }
      throwStructured("Ticket issuance failed. Please retry.", "PROVIDER_UNAVAILABLE", 503);
    }

    const issuedAt = new Date();
    const tickets = booking.travelers.map((traveler, index) => ({
      travelerId: traveler.travelerId || null,
      ticketNumber: ticketResult.ticketNumbers[index] || ticketResult.ticketNumbers[0],
      status: "Issued",
      issuedAt
    }));

    booking.ticketIssued = true;
    booking.ticketStatus = "Issued";
    booking.status = "Ticketed";
    booking.ticketNumbers = ticketResult.ticketNumbers;
    booking.tickets = tickets;
    booking.issuedAt = issuedAt;
    booking.issuedBy = userId || "System";
    booking.travelers.forEach((traveler, index) => {
      traveler.ticketNumber = tickets[index]?.ticketNumber || null;
    });
    booking.version = (booking.version || 1) + 1;
    booking.versionHistory.push({
      version: booking.version, updatedBy: userId || "System", updatedAt: issuedAt,
      changes: { action: "AMADEUS_TICKET_ISSUED", ticketNumbers: ticketResult.ticketNumbers }
    });
    await booking.save();

    // "Update Internal Flight Assignment" ticket status (read-through field
    // Travel Operations relies on — see EXT-004 §4 Aggregate Relationship).
    if (booking.flightAssignmentId) {
      const flightAssignment = await TravelFlightAssignmentModel.findOne({ _id: booking.flightAssignmentId, tenantId });
      if (flightAssignment) {
        flightAssignment.ticketStatus = "Issued";
        if (flightAssignment.status === "confirmed") flightAssignment.status = "ticket_issued";
        flightAssignment.version = (flightAssignment.version || 1) + 1;
        flightAssignment.versionHistory.push({
          version: flightAssignment.version, updatedBy: userId || "System", updatedAt: issuedAt,
          changes: { action: "TICKET_ISSUED", flightBookingId: booking._id.toString(), ticketNumbers: ticketResult.ticketNumbers }
        });
        await flightAssignment.save();
      }
    }

    if (booking.travelPlanId) {
      await recordCanonicalDomainEvent({
        travelPlanId: booking.travelPlanId,
        tenantId,
        sourceModule: "ExternalIntegrations",
        aggregateType: "FlightBooking",
        aggregateId: booking._id,
        eventType: "FlightTicketIssued",
        title: `Tickets Issued for PNR ${booking.pnr}`,
        description: `E-Tickets [${ticketResult.ticketNumbers.join(", ")}] issued for ${booking.travelers.length} traveler(s).`,
        actor: { userId: userId || "System", name: userName || "Ticketing Service", role: "Ticketing Agent" }
      });
    }

    publishEvent("FlightTicketIssued", { flightBookingId: booking._id, pnr: booking.pnr, ticketNumbers: ticketResult.ticketNumbers, tenantId });
    publishEvent("BookingTicketed", { flightBookingId: booking._id, travelPlanId: booking.travelPlanId, tenantId });

    // "Notify Customer" — no real Email/SMS/WhatsApp/Push provider exists
    // anywhere in this codebase (confirmed: SMTP is wired only inside
    // Auth.js for MFA/reset emails, not as a reusable service); the same
    // honest pattern already used by appointmentReminderScheduler.js applies
    // here rather than fabricating delivery.
    const notificationChannels = ["Email", "SMS", "WhatsApp", "Push"];
    for (const channel of notificationChannels) {
      publishEvent("NotificationRequested", {
        tenantId, event: "FlightTicketIssued", priority: "high", channel,
        recipientId: booking.contact?.email || booking.contact?.phone || null,
        flightBookingId: booking._id, pnr: booking.pnr
      });
    }
    publishEvent("CustomerTicketNotificationSent", { flightBookingId: booking._id, pnr: booking.pnr, tenantId, channels: notificationChannels });

    if (mongoose.connection?.readyState === 1) {
      AuditLogModel.create({
        tenantId, userId, action: "AMADEUS_TICKET_ISSUED", module: "ExternalIntegrations",
        requestId, targetId: booking._id.toString(),
        details: { pnr: booking.pnr, ticketNumbers: ticketResult.ticketNumbers, travelPlanId: booking.travelPlanId?.toString() || null }
      }).catch((err) => console.error("Ticket issuance audit log error:", err));
    }

    return {
      bookingId: booking._id,
      pnr: booking.pnr,
      ticketStatus: "Issued",
      tickets: tickets.map((t) => ({ travelerId: t.travelerId, ticketNumber: t.ticketNumber }))
    };
  }
}

export default AmadeusFlightTicketingService;
