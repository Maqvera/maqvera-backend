import FlightBookingModel from "../models/FlightBookingModel.js";
import BookingHeaderModel from "../models/BookingHeaderModel.js";
import TravelPlanModel from "../models/TravelPlanModel.js";
import AuditLogModel from "../models/AuditLogmodel.js";
import GdsIntegrationService from "../services/GdsIntegrationService.js";
import { recordCanonicalDomainEvent } from "./TravelNotesTimelineController.js";
import { sendError, sendSuccess } from "../utils/apiResponse.js";
import { publishEvent } from "../utils/eventBus.js";
import { createRequestId } from "../utils/authTokens.js";
import { getTicketingPolicyConfig } from "../utils/gdsConfig.js";
import CacheManager from "../utils/cacheManager.js";

/**
 * 1. POST /api/v1/flight-bookings
 * Create live airline reservation (PNR) from Flight Offer.
 */
export const CreateFlightBooking = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const tenantId = req.auth?.tenantId || "default";
    const userId = req.auth?.userId || req.auth?.id;
    const permissions = req.auth?.permissions || [];

    if (!permissions.includes("flight.book") && !permissions.includes("admin")) {
      return sendError(res, 403, "Permission denied.", requestId);
    }

    const {
      offerId,
      bookingId,
      travelPlanId,
      provider = "Amadeus",
      travelers = [],
      contact = {},
      totalPrice = 145000,
      currency = "PKR",
      segments = []
    } = req.body;

    if (!offerId) {
      return sendError(res, 400, "offerId is required.", requestId);
    }

    if (!Array.isArray(travelers) || travelers.length === 0) {
      return sendError(res, 400, "At least one traveler is required for booking.", requestId);
    }

    for (const traveler of travelers) {
      if (!traveler.firstName || !traveler.lastName || !traveler.passportNumber) {
        return sendError(res, 400, "firstName, lastName, and passportNumber are required for each traveler.", requestId);
      }
      // Validation Rule "Passport Valid" — presence alone was previously the
      // only check; an expired passport would have been accepted silently.
      if (traveler.passportExpiry) {
        const expiry = new Date(traveler.passportExpiry);
        if (Number.isNaN(expiry.getTime()) || expiry <= new Date()) {
          return sendError(res, 400, `Passport for ${traveler.firstName} ${traveler.lastName} is expired or has an invalid expiry date.`, requestId);
        }
      }
    }

    // Business Rule "No duplicate bookings" / Endpoint Information
    // "Idempotent: Yes" — a retried or double-submitted request for the same
    // offer previously created a second live PNR with the airline. Reusing
    // an existing non-terminal booking for the same tenant+offer makes the
    // endpoint genuinely idempotent instead of only claiming to be.
    const existingBooking = await FlightBookingModel.findOne({
      tenantId, offerId, status: { $nin: ["Cancelled", "Expired", "Rejected", "Failed"] }
    });
    if (existingBooking) {
      return sendSuccess(res, 200, "An active booking already exists for this offer; returning the existing reservation.", {
        flightBookingId: existingBooking._id,
        bookingId: existingBooking.bookingId,
        provider: existingBooking.provider,
        providerBookingReference: existingBooking.providerBookingReference,
        pnr: existingBooking.pnr,
        status: existingBooking.status,
        totalPrice: existingBooking.totalPrice,
        currency: existingBooking.currency,
        ticketingDeadline: existingBooking.ticketingDeadline,
        travelerCount: existingBooking.travelers.length,
        createdAt: existingBooking.createdAt,
        idempotentReplay: true
      }, requestId);
    }

    // "Same Tenant" — a bookingId the client supplies must actually belong
    // to this tenant; the previous code silently swallowed a non-matching
    // update (`.catch(() => {})`) instead of rejecting the request.
    if (bookingId) {
      const bookingHeaderExists = await BookingHeaderModel.exists({ _id: bookingId, tenantId });
      if (!bookingHeaderExists) {
        return sendError(res, 404, "bookingId does not exist for this tenant.", requestId);
      }
    }

    // Step 1: Revalidate Offer with Provider — "Offer Exists", "Offer Not
    // Expired", "Fare Still Valid", "Seats Available" against the real
    // cached search offer (see GdsIntegrationService.revalidateOffer).
    const revalidation = await GdsIntegrationService.revalidateOffer({ offerId, tenantId, provider });
    if (!revalidation.isValid) {
      return sendError(res, 400, revalidation.reason || "Flight offer is no longer valid or seats are sold out.", requestId);
    }
    if (revalidation.availableSeats < travelers.length) {
      return sendError(res, 400, `Only ${revalidation.availableSeats} seat(s) available on this offer for ${travelers.length} traveler(s).`, requestId);
    }
    // Validation Rule "Passenger Count Matches Offer".
    if (revalidation.requestedPassengers && travelers.length !== revalidation.requestedPassengers) {
      return sendError(res, 400, `Traveler count (${travelers.length}) does not match the original search's passenger count (${revalidation.requestedPassengers}).`, requestId);
    }

    // The offer's real provider (resolved from the search cache) is
    // authoritative — a client-supplied `provider` field is not trusted for
    // routing the booking, only used as a fallback when no cached offer
    // exists (e.g. an offer sourced from a dedicated entity-search call).
    const resolvedProvider = revalidation.provider || provider;

    // Step 2: Create PNR via GDS Provider Adapter
    // EXT-004 — pass the real raw Amadeus offer through when the original
    // search was live, so a real Flight Create Orders API call can actually
    // be attempted (previously this endpoint could never book for real even
    // with valid credentials, since AmadeusAdapter.createFlightBooking had
    // no complete offer object to send).
    const gdsResult = await GdsIntegrationService.createFlightBooking({
      offerId,
      provider: resolvedProvider,
      travelers,
      contact,
      totalPrice: revalidation.currentPrice || totalPrice,
      currency: revalidation.currency || currency,
      rawFlightOffer: revalidation.rawOffer || undefined,
      tenantId
    });

    const ticketingDeadline = gdsResult.ticketingDeadline ? new Date(gdsResult.ticketingDeadline) : new Date(Date.now() + 24 * 60 * 60 * 1000);

    // Step 3: Create FlightBooking Model Document
    const flightBooking = await FlightBookingModel.create({
      tenantId,
      bookingId: bookingId || null,
      travelPlanId: travelPlanId || null,
      offerId,
      provider: gdsResult.provider || resolvedProvider,
      pnr: gdsResult.pnr,
      providerBookingReference: gdsResult.providerBookingReference || gdsResult.pnr,
      // EXT-008 audit finding: this booking path never persisted the order
      // reference/raw snapshot AmadeusAdapter.createFlightBooking already
      // returns (only the newer EXT-004 booking path did) — meaning a
      // booking created here could never be found by EXT-008's
      // flightOrderId lookup, nor tell live from dynamic-sandbox data.
      airlineOrderId: gdsResult.airlineOrderId || gdsResult.providerBookingReference || gdsResult.pnr,
      bookingSnapshot: gdsResult._raw || null,
      // EXT-010 — real carrier data only when the client actually supplied
      // segment details; left null otherwise rather than guessed.
      airlineCode: segments[0]?.airlineCode || null,
      airlineName: segments[0]?.airline || null,
      status: "Reserved",
      totalPrice: gdsResult.totalPrice || totalPrice,
      currency: revalidation.currency || currency,
      ticketingDeadline,
      travelers: travelers.map((t) => ({
        firstName: t.firstName,
        lastName: t.lastName,
        gender: t.gender || "Male",
        dateOfBirth: t.dateOfBirth ? new Date(t.dateOfBirth) : null,
        passportNumber: t.passportNumber,
        passportExpiry: t.passportExpiry ? new Date(t.passportExpiry) : null,
        nationality: t.nationality || "PK"
      })),
      contact,
      segments,
      version: 1,
      versionHistory: [
        {
          version: 1,
          updatedBy: userId || "Staff",
          updatedAt: new Date(),
          changes: { action: "PNR_CREATED", pnr: gdsResult.pnr }
        }
      ]
    });

    // Step 4: Sync to BookingHeader or TravelPlan if linked
    if (bookingId) {
      await BookingHeaderModel.updateOne(
        { _id: bookingId, tenantId },
        { $set: { pnr: gdsResult.pnr, bookingStatus: "CONFIRMED" } }
      ).catch(() => {});
    }

    // Step 5: Timeline & Domain Events
    if (travelPlanId) {
      await recordCanonicalDomainEvent({
        travelPlanId,
        tenantId,
        sourceModule: "GDSIntegration",
        aggregateType: "FlightBooking",
        aggregateId: flightBooking._id,
        eventType: "PNRCreated",
        title: `Flight PNR Created: ${gdsResult.pnr}`,
        description: `Airline reservation confirmed via ${resolvedProvider} for ${travelers.length} traveler(s).`,
        actor: { userId: userId || "System", name: "GDS Booking Agent", role: "Ops Coordinator" }
      });
    }

    publishEvent("FlightBookingCreated", {
      flightBookingId: flightBooking._id,
      pnr: gdsResult.pnr,
      tenantId,
      provider: resolvedProvider
    });

    publishEvent("PNRCreated", {
      flightBookingId: flightBooking._id,
      pnr: gdsResult.pnr,
      tenantId
    });

    try {
      await AuditLogModel.create({
        tenantId,
        userId,
        action: "CREATE_FLIGHT_BOOKING",
        module: "GDSIntegration",
        targetId: flightBooking._id.toString(),
        details: { pnr: gdsResult.pnr, provider: resolvedProvider }
      });
    } catch (auditErr) {
      console.error("Audit error:", auditErr);
    }

    return sendSuccess(
      res,
      201,
      "Flight reservation (PNR) created successfully.",
      {
        flightBookingId: flightBooking._id,
        bookingId: flightBooking.bookingId,
        provider: flightBooking.provider,
        providerBookingReference: flightBooking.providerBookingReference,
        pnr: flightBooking.pnr,
        status: flightBooking.status,
        totalPrice: flightBooking.totalPrice,
        currency: flightBooking.currency,
        ticketingDeadline: flightBooking.ticketingDeadline,
        travelerCount: flightBooking.travelers.length,
        createdAt: flightBooking.createdAt
      },
      requestId
    );
  } catch (err) {
    console.error("CreateFlightBooking Error:", err);
    publishEvent("FlightBookingFailed", {
      tenantId: req.auth?.tenantId || "default",
      offerId: req.body?.offerId || null,
      error: err.message
    });
    return sendError(res, 500, err.message || "Failed to create flight booking.", requestId);
  }
};

/**
 * 2. GET /api/v1/flight-bookings/:flightBookingId
 * Retrieve complete flight booking provider snapshot by ID or PNR.
 */
export const GetFlightBookingById = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const tenantId = req.auth?.tenantId || "default";
    const permissions = req.auth?.permissions || [];
    if (!permissions.includes("flight.book") && !permissions.includes("flight.read") && !permissions.includes("admin")) {
      return sendError(res, 403, "Permission denied.", requestId);
    }
    const { flightBookingId } = req.params;

    const query = flightBookingId.length === 24
      ? { _id: flightBookingId, tenantId }
      : { pnr: flightBookingId.toUpperCase(), tenantId };

    const booking = await FlightBookingModel.findOne(query);
    if (!booking) {
      return sendError(res, 404, "Flight booking / PNR not found.", requestId);
    }

    return sendSuccess(res, 200, "Flight booking details retrieved successfully.", booking, requestId);
  } catch (err) {
    console.error("GetFlightBookingById Error:", err);
    return sendError(res, 500, err.message || "Failed to retrieve flight booking.", requestId);
  }
};

/**
 * 3. POST /api/v1/flight-bookings/revalidate
 * Pre-booking offer price & availability revalidation.
 */
export const RevalidateBookingOffer = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const tenantId = req.auth?.tenantId || "default";
    const permissions = req.auth?.permissions || [];
    if (!permissions.includes("flight.book") && !permissions.includes("admin")) {
      return sendError(res, 403, "Permission denied.", requestId);
    }
    const { offerId, provider = "Amadeus" } = req.body;
    if (!offerId) {
      return sendError(res, 400, "offerId is required.", requestId);
    }

    const revalidation = await GdsIntegrationService.revalidateOffer({ offerId, tenantId, provider });

    publishEvent("FlightBookingRevalidated", { offerId, tenantId, provider: revalidation.provider || provider, revalidation });

    return sendSuccess(res, 200, "Flight offer revalidated successfully.", revalidation, requestId);
  } catch (err) {
    console.error("RevalidateBookingOffer Error:", err);
    return sendError(res, 500, err.message || "Failed to revalidate flight offer.", requestId);
  }
};

/**
 * 4. POST /api/v1/flight-bookings/:flightBookingId/cancel
 * Cancel flight reservation with provider.
 */
export const CancelFlightBooking = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const tenantId = req.auth?.tenantId || "default";
    const userId = req.auth?.userId || req.auth?.id;
    const permissions = req.auth?.permissions || [];
    if (!permissions.includes("flight.book") && !permissions.includes("admin")) {
      return sendError(res, 403, "Permission denied.", requestId);
    }
    const { flightBookingId } = req.params;
    // Business Rule "Cancellation reason mandatory" — a silent default
    // previously made this field optional in practice.
    const { reason } = req.body;
    if (!reason || !String(reason).trim()) {
      return sendError(res, 400, "A cancellation reason is required.", requestId);
    }

    const booking = await FlightBookingModel.findOne({ _id: flightBookingId, tenantId });
    if (!booking) {
      return sendError(res, 404, "Flight booking not found.", requestId);
    }

    if (booking.status === "Cancelled") {
      return sendError(res, 400, "Flight booking is already cancelled.", requestId);
    }

    // Cancel via GDS Integration Layer
    await GdsIntegrationService.cancelFlightBooking({
      provider: booking.provider,
      pnr: booking.pnr,
      reason,
      tenantId
    });

    booking.status = "Cancelled";
    booking.cancellationReason = reason;
    booking.cancelledAt = new Date();
    booking.cancelledBy = userId || "Staff";
    booking.version = (booking.version || 1) + 1;
    booking.versionHistory.push({
      version: booking.version,
      updatedBy: userId || "Staff",
      updatedAt: new Date(),
      changes: { action: "CANCELLED", reason }
    });

    await booking.save();

    // EXT-008 §9/§14 "Cache invalidated after... Cancellation" — a stale
    // seat map for a now-cancelled reservation must never be served.
    if (booking.airlineOrderId) {
      await CacheManager.invalidate(`seat-map:${booking.airlineOrderId}`);
    }

    if (booking.travelPlanId) {
      await recordCanonicalDomainEvent({
        travelPlanId: booking.travelPlanId,
        tenantId,
        sourceModule: "GDSIntegration",
        aggregateType: "FlightBooking",
        aggregateId: booking._id,
        eventType: "FlightBookingCancelled",
        title: `PNR ${booking.pnr} Cancelled`,
        description: `Flight booking cancelled. Reason: ${reason}`,
        actor: { userId: userId || "System", name: "Ops Coordinator", role: "Ops Coordinator" }
      });
    }

    publishEvent("FlightBookingCancelled", {
      flightBookingId: booking._id,
      pnr: booking.pnr,
      tenantId
    });

    return sendSuccess(res, 200, "Flight booking cancelled successfully.", booking, requestId);
  } catch (err) {
    console.error("CancelFlightBooking Error:", err);
    return sendError(res, 500, err.message || "Failed to cancel flight booking.", requestId);
  }
};

/**
 * 5. POST /api/v1/flight-bookings/:flightBookingId/sync
 * Sync PNR status & schedule updates from provider.
 */
export const SyncFlightBooking = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const tenantId = req.auth?.tenantId || "default";
    const userId = req.auth?.userId || req.auth?.id;
    const permissions = req.auth?.permissions || [];
    if (!permissions.includes("flight.book") && !permissions.includes("admin")) {
      return sendError(res, 403, "Permission denied.", requestId);
    }
    const { flightBookingId } = req.params;

    const booking = await FlightBookingModel.findOne({ _id: flightBookingId, tenantId });
    if (!booking) {
      return sendError(res, 404, "Flight booking not found.", requestId);
    }

    const syncResult = await GdsIntegrationService.syncFlightBooking({
      provider: booking.provider,
      pnr: booking.pnr,
      tenantId
    });

    // "Synchronization Includes: Booking Status..." / "Update ERP Snapshot"
    // — previously only bumped a timestamp and discarded the provider's
    // actual status, so a schedule/status change at the airline never
    // propagated into the ERP snapshot.
    const previousStatus = booking.status;
    if (syncResult.status && syncResult.status !== booking.status && FlightBookingModel.schema.path("status").enumValues.includes(syncResult.status)) {
      booking.status = syncResult.status;
      booking.version = (booking.version || 1) + 1;
      booking.versionHistory.push({
        version: booking.version,
        updatedBy: userId || "System",
        updatedAt: new Date(),
        changes: { action: "PROVIDER_SYNC", previousStatus, newStatus: syncResult.status }
      });
    }
    booking.lastSynchronizedAt = new Date();
    await booking.save();

    // EXT-008 §9/§14 "Cache invalidated after... Booking Change" — a
    // provider sync that actually changed the booking status invalidates
    // any cached seat map, since seat availability can shift alongside it.
    if (booking.airlineOrderId && previousStatus !== booking.status) {
      await CacheManager.invalidate(`seat-map:${booking.airlineOrderId}`);
    }

    if (booking.travelPlanId && previousStatus !== booking.status) {
      await recordCanonicalDomainEvent({
        travelPlanId: booking.travelPlanId,
        tenantId,
        sourceModule: "GDSIntegration",
        aggregateType: "FlightBooking",
        aggregateId: booking._id,
        eventType: "TicketSynchronized",
        title: `PNR ${booking.pnr} Synchronized`,
        description: `Status changed from ${previousStatus} to ${booking.status}.`,
        actor: { userId: userId || "System", name: "GDS Sync Worker", role: "System" }
      });
    }

    publishEvent("ProviderBookingSynchronized", {
      flightBookingId: booking._id,
      pnr: booking.pnr,
      tenantId
    });
    // Doc's Domain Events list names this "TicketSynchronized" specifically;
    // kept alongside the pre-existing event name so nothing already
    // listening to it breaks.
    publishEvent("TicketSynchronized", {
      flightBookingId: booking._id,
      pnr: booking.pnr,
      previousStatus,
      newStatus: booking.status,
      tenantId
    });

    AuditLogModel.create({
      tenantId, userId, action: "SYNC_FLIGHT_BOOKING", module: "GDSIntegration",
      targetId: booking._id.toString(), details: { pnr: booking.pnr, previousStatus, newStatus: booking.status }
    }).catch((err) => console.error("Audit log error:", err));

    return sendSuccess(res, 200, "Flight booking synchronized successfully with provider.", { booking, syncResult }, requestId);
  } catch (err) {
    console.error("SyncFlightBooking Error:", err);
    return sendError(res, 500, err.message || "Failed to sync flight booking.", requestId);
  }
};

/**
 * 7. GET /api/v1/flight-bookings/:flightBookingId/pnr
 * Retrieve full PNR information, ticket numbers, SSR, OSI, and EMD.
 */
export const GetPnrDetails = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const tenantId = req.auth?.tenantId || "default";
    const permissions = req.auth?.permissions || [];
    if (!permissions.includes("flight.ticket") && !permissions.includes("flight.book") && !permissions.includes("flight.read") && !permissions.includes("admin")) {
      return sendError(res, 403, "Permission denied.", requestId);
    }
    const { flightBookingId } = req.params;

    const booking = await FlightBookingModel.findOne({
      $or: [{ _id: flightBookingId.length === 24 ? flightBookingId : null }, { pnr: flightBookingId.toUpperCase() }],
      tenantId
    });

    if (!booking) {
      return sendError(res, 404, "PNR / Flight booking not found.", requestId);
    }

    return sendSuccess(res, 200, "PNR details retrieved successfully.", booking, requestId);
  } catch (err) {
    console.error("GetPnrDetails Error:", err);
    return sendError(res, 500, err.message || "Failed to retrieve PNR details.", requestId);
  }
};

/**
 * 8. POST /api/v1/flight-bookings/:flightBookingId/ticket
 * Issues electronic airline tickets for confirmed PNR.
 */
export const IssueTicket = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const tenantId = req.auth?.tenantId || "default";
    const userId = req.auth?.userId || req.auth?.id;
    const permissions = req.auth?.permissions || [];
    if (!permissions.includes("flight.ticket") && !permissions.includes("flight.book") && !permissions.includes("admin")) {
      return sendError(res, 403, "Permission denied.", requestId);
    }
    const { flightBookingId } = req.params;
    const { paymentReference, remarks } = req.body;

    // Validation Rule "Payment Completed" — was previously optional
    // (silently stored as null), meaning a ticket could be issued with the
    // airline with no confirmed payment reference at all.
    if (!paymentReference || !String(paymentReference).trim()) {
      return sendError(res, 400, "paymentReference is required before ticket issuance.", requestId);
    }

    const booking = await FlightBookingModel.findOne({ _id: flightBookingId, tenantId });
    if (!booking) {
      return sendError(res, 404, "Flight booking not found.", requestId);
    }

    // Business Rule "Ticket issuance is idempotent. Duplicate issuance
    // prevented."
    if (booking.ticketStatus === "Issued") {
      return sendError(res, 400, "Tickets have already been issued for this PNR.", requestId);
    }

    // Validation Rule "Reservation Confirmed" — a cancelled/expired/rejected
    // booking previously had no guard against ticket issuance at all.
    if (["Cancelled", "Expired", "Rejected", "Failed"].includes(booking.status)) {
      return sendError(res, 400, `Cannot issue tickets for a booking with status '${booking.status}'.`, requestId);
    }

    const ticketResult = await GdsIntegrationService.issueTicket({
      provider: booking.provider,
      pnr: booking.pnr,
      travelersCount: booking.travelers.length,
      tenantId
    });

    booking.ticketStatus = "Issued";
    booking.status = "Ticketed";
    booking.ticketNumbers = ticketResult.ticketNumbers;
    booking.paymentReference = paymentReference || null;
    booking.issuedAt = new Date();
    booking.issuedBy = userId || "Staff";

    // Assign ticket numbers to travelers
    booking.travelers.forEach((traveler, index) => {
      traveler.ticketNumber = ticketResult.ticketNumbers[index] || ticketResult.ticketNumbers[0];
    });

    booking.version = (booking.version || 1) + 1;
    booking.versionHistory.push({
      version: booking.version,
      updatedBy: userId || "Staff",
      updatedAt: new Date(),
      changes: { action: "TICKET_ISSUED", ticketNumbers: ticketResult.ticketNumbers, paymentReference }
    });

    await booking.save();

    if (booking.travelPlanId) {
      await recordCanonicalDomainEvent({
        travelPlanId: booking.travelPlanId,
        tenantId,
        sourceModule: "GDSIntegration",
        aggregateType: "FlightBooking",
        aggregateId: booking._id,
        eventType: "TicketIssued",
        title: `Tickets Issued for PNR ${booking.pnr}`,
        description: `E-Tickets [${ticketResult.ticketNumbers.join(", ")}] issued successfully.`,
        actor: { userId: userId || "System", name: "Ticketing Desk", role: "Ticketing Agent" }
      });
    }

    publishEvent("TicketIssued", {
      flightBookingId: booking._id,
      pnr: booking.pnr,
      ticketNumbers: ticketResult.ticketNumbers,
      tenantId
    });

    AuditLogModel.create({
      tenantId, userId, action: "ISSUE_FLIGHT_TICKET", module: "GDSIntegration",
      targetId: booking._id.toString(), details: { pnr: booking.pnr, ticketNumbers: ticketResult.ticketNumbers, paymentReference }
    }).catch((err) => console.error("Audit log error:", err));

    return sendSuccess(
      res,
      201,
      "Electronic tickets issued successfully.",
      {
        ticketStatus: booking.ticketStatus,
        ticketNumbers: booking.ticketNumbers,
        issuedAt: booking.issuedAt,
        pnr: booking.pnr
      },
      requestId
    );
  } catch (err) {
    console.error("IssueTicket Error:", err);
    return sendError(res, 500, err.message || "Failed to issue tickets.", requestId);
  }
};

/**
 * 9. POST /api/v1/flight-bookings/:flightBookingId/void
 * Voids an issued ticket within airline void window.
 */
export const VoidTicket = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const tenantId = req.auth?.tenantId || "default";
    const userId = req.auth?.userId || req.auth?.id;
    const permissions = req.auth?.permissions || [];
    if (!permissions.includes("flight.ticket") && !permissions.includes("flight.book") && !permissions.includes("admin")) {
      return sendError(res, 403, "Permission denied.", requestId);
    }
    const { flightBookingId } = req.params;
    const { reason } = req.body;
    if (!reason || !String(reason).trim()) {
      return sendError(res, 400, "A void reason is required.", requestId);
    }

    const booking = await FlightBookingModel.findOne({ _id: flightBookingId, tenantId });
    if (!booking) {
      return sendError(res, 404, "Flight booking not found.", requestId);
    }

    if (booking.ticketStatus !== "Issued") {
      return sendError(res, 400, "Only issued tickets can be voided.", requestId);
    }

    // Business Rule "Void allowed only within airline policy" — previously
    // completely unenforced; a ticket issued years ago could still be
    // "voided" through this endpoint.
    const { voidWindowHours } = getTicketingPolicyConfig();
    const hoursSinceIssued = booking.issuedAt ? (Date.now() - new Date(booking.issuedAt).getTime()) / 3_600_000 : Infinity;
    if (hoursSinceIssued > voidWindowHours) {
      return sendError(res, 400, `Void window has expired. Tickets can only be voided within ${voidWindowHours} hours of issuance.`, requestId);
    }

    await GdsIntegrationService.voidTicket({
      provider: booking.provider,
      pnr: booking.pnr,
      reason,
      tenantId
    });

    booking.ticketStatus = "Voided";
    booking.status = "Cancelled";
    booking.voidedAt = new Date();
    booking.voidReason = reason;

    booking.version = (booking.version || 1) + 1;
    booking.versionHistory.push({
      version: booking.version,
      updatedBy: userId || "Staff",
      updatedAt: new Date(),
      changes: { action: "TICKET_VOIDED", reason }
    });

    await booking.save();

    if (booking.travelPlanId) {
      await recordCanonicalDomainEvent({
        travelPlanId: booking.travelPlanId,
        tenantId,
        sourceModule: "GDSIntegration",
        aggregateType: "FlightBooking",
        aggregateId: booking._id,
        eventType: "TicketVoided",
        title: `Ticket Voided for PNR ${booking.pnr}`,
        description: `Reason: ${reason}`,
        actor: { userId: userId || "System", name: "Ticketing Desk", role: "Ticketing Agent" }
      });
    }

    publishEvent("TicketVoided", {
      flightBookingId: booking._id,
      pnr: booking.pnr,
      tenantId
    });

    AuditLogModel.create({
      tenantId, userId, action: "VOID_FLIGHT_TICKET", module: "GDSIntegration",
      targetId: booking._id.toString(), details: { pnr: booking.pnr, reason }
    }).catch((err) => console.error("Audit log error:", err));

    return sendSuccess(res, 200, "Ticket voided successfully.", booking, requestId);
  } catch (err) {
    console.error("VoidTicket Error:", err);
    return sendError(res, 500, err.message || "Failed to void ticket.", requestId);
  }
};

/**
 * 10. POST /api/v1/flight-bookings/:flightBookingId/reissue
 * Reissue / exchange ticket for new flight offer.
 */
export const ReissueTicket = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const tenantId = req.auth?.tenantId || "default";
    const userId = req.auth?.userId || req.auth?.id;
    const permissions = req.auth?.permissions || [];
    if (!permissions.includes("flight.ticket") && !permissions.includes("flight.book") && !permissions.includes("admin")) {
      return sendError(res, 403, "Permission denied.", requestId);
    }
    const { flightBookingId } = req.params;
    const { reason, newFlightOfferId } = req.body;

    if (!reason || !newFlightOfferId) {
      return sendError(res, 400, "reason and newFlightOfferId are required.", requestId);
    }

    const booking = await FlightBookingModel.findOne({ _id: flightBookingId, tenantId });
    if (!booking) {
      return sendError(res, 404, "Flight booking not found.", requestId);
    }

    // "Validate Existing Ticket" — reissuing something that was never
    // issued (or already voided/refunded) was previously unguarded.
    if (booking.ticketStatus !== "Issued") {
      return sendError(res, 400, "Only an issued ticket can be reissued.", requestId);
    }

    // "Validate New Offer" + "Calculate Fare Difference" — the new offer
    // was never checked against anything real, and fareDiff was whatever
    // number the client sent (defaulting to 0), not calculated at all.
    const revalidation = await GdsIntegrationService.revalidateOffer({ offerId: newFlightOfferId, tenantId });
    if (!revalidation.isValid) {
      return sendError(res, 400, revalidation.reason || "The new flight offer is no longer valid.", requestId);
    }
    const fareDiff = Number((revalidation.currentPrice - booking.totalPrice).toFixed(2));

    const reissueResult = await GdsIntegrationService.reissueTicket({
      provider: booking.provider,
      pnr: booking.pnr,
      newFlightOfferId,
      fareDiff,
      tenantId
    });

    const oldTickets = [...booking.ticketNumbers];
    booking.ticketNumbers = reissueResult.newTicketNumbers;
    booking.ticketStatus = "Reissued";

    booking.reissueHistory.push({
      oldTicketNumbers: oldTickets,
      newTicketNumbers: reissueResult.newTicketNumbers,
      newFlightOfferId,
      reason,
      fareDiff,
      reissuedAt: new Date()
    });

    booking.version = (booking.version || 1) + 1;
    booking.versionHistory.push({
      version: booking.version,
      updatedBy: userId || "Staff",
      updatedAt: new Date(),
      changes: { action: "TICKET_REISSUED", oldTicketNumbers: oldTickets, newTicketNumbers: reissueResult.newTicketNumbers, fareDiff }
    });
    await booking.save();

    // EXT-008 §9/§14 "Cache invalidated after... Ticket Reissue" — the new
    // flight offer means the previously cached seat map no longer applies.
    if (booking.airlineOrderId) {
      await CacheManager.invalidate(`seat-map:${booking.airlineOrderId}`);
    }

    if (booking.travelPlanId) {
      await recordCanonicalDomainEvent({
        travelPlanId: booking.travelPlanId,
        tenantId,
        sourceModule: "GDSIntegration",
        aggregateType: "FlightBooking",
        aggregateId: booking._id,
        eventType: "TicketReissued",
        title: `Ticket Reissued for PNR ${booking.pnr}`,
        description: `Reason: ${reason}. Fare difference: ${fareDiff} ${booking.currency}.`,
        actor: { userId: userId || "System", name: "Ticketing Desk", role: "Ticketing Agent" }
      });
    }

    publishEvent("TicketReissued", {
      flightBookingId: booking._id,
      pnr: booking.pnr,
      newTicketNumbers: reissueResult.newTicketNumbers,
      fareDiff,
      tenantId
    });

    AuditLogModel.create({
      tenantId, userId, action: "REISSUE_FLIGHT_TICKET", module: "GDSIntegration",
      targetId: booking._id.toString(), details: { pnr: booking.pnr, newFlightOfferId, reason, fareDiff }
    }).catch((err) => console.error("Audit log error:", err));

    return sendSuccess(res, 200, "Ticket reissued successfully.", booking, requestId);
  } catch (err) {
    console.error("ReissueTicket Error:", err);
    return sendError(res, 500, err.message || "Failed to reissue ticket.", requestId);
  }
};

/**
 * 11. POST /api/v1/flight-bookings/:flightBookingId/refund
 * Initiates ticket refund request.
 */
export const RefundTicket = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const tenantId = req.auth?.tenantId || "default";
    const userId = req.auth?.userId || req.auth?.id;
    const permissions = req.auth?.permissions || [];
    if (!permissions.includes("flight.ticket") && !permissions.includes("flight.book") && !permissions.includes("admin")) {
      return sendError(res, 403, "Permission denied.", requestId);
    }
    const { flightBookingId } = req.params;
    // Business Rule "Refund reason mandatory" — a silent default previously
    // made this field optional in practice.
    const { reason } = req.body;
    if (!reason || !String(reason).trim()) {
      return sendError(res, 400, "A refund reason is required.", requestId);
    }

    const booking = await FlightBookingModel.findOne({ _id: flightBookingId, tenantId });
    if (!booking) {
      return sendError(res, 404, "Flight booking not found.", requestId);
    }
    if (booking.ticketStatus !== "Issued") {
      return sendError(res, 400, "Only an issued ticket can be refunded.", requestId);
    }

    // "Retrieve Fare Rules → Calculate Refund Eligibility" — refundAmount
    // and penaltyFee were previously taken directly from client input
    // (defaulting to 0/0), meaning the caller could request any refund
    // amount with no server-side calculation against real fare rules.
    // "Finance module owns payment refund" — this endpoint only calculates
    // eligibility and notifies Finance via the domain event; it never moves
    // money itself.
    const fareRules = await GdsIntegrationService.getFareRules({ offerId: booking.offerId, provider: booking.provider });
    const { defaultCancellationPenaltyPct } = getTicketingPolicyConfig();
    const parsedPenalty = Number(String(fareRules.rules?.cancellationFeeBeforeDeparture || "").replace(/[^0-9.]/g, ""));
    const penaltyFee = Number.isFinite(parsedPenalty) && parsedPenalty > 0
      ? parsedPenalty
      : Number((booking.totalPrice * (defaultCancellationPenaltyPct / 100)).toFixed(2));
    const refundAmount = Math.max(0, Number((booking.totalPrice - penaltyFee).toFixed(2)));

    await GdsIntegrationService.requestRefund({
      provider: booking.provider,
      pnr: booking.pnr,
      refundAmount,
      penaltyFee,
      tenantId
    });

    booking.ticketStatus = "Refund Requested";
    booking.refundDetails = {
      refundAmount,
      penaltyFee,
      status: "PENDING_FINANCE_APPROVAL",
      requestedAt: new Date(),
      reason
    };
    booking.version = (booking.version || 1) + 1;
    booking.versionHistory.push({
      version: booking.version,
      updatedBy: userId || "Staff",
      updatedAt: new Date(),
      changes: { action: "REFUND_REQUESTED", refundAmount, penaltyFee, reason }
    });

    await booking.save();

    if (booking.travelPlanId) {
      await recordCanonicalDomainEvent({
        travelPlanId: booking.travelPlanId,
        tenantId,
        sourceModule: "GDSIntegration",
        aggregateType: "FlightBooking",
        aggregateId: booking._id,
        eventType: "RefundRequested",
        title: `Refund Requested for PNR ${booking.pnr}`,
        description: `Reason: ${reason}. Eligible refund: ${refundAmount} ${booking.currency} (penalty ${penaltyFee}).`,
        actor: { userId: userId || "System", name: "Ticketing Desk", role: "Ticketing Agent" }
      });
    }

    publishEvent("RefundRequested", {
      flightBookingId: booking._id,
      pnr: booking.pnr,
      refundAmount,
      penaltyFee,
      tenantId
    });

    AuditLogModel.create({
      tenantId, userId, action: "REQUEST_FLIGHT_REFUND", module: "GDSIntegration",
      targetId: booking._id.toString(), details: { pnr: booking.pnr, reason, refundAmount, penaltyFee }
    }).catch((err) => console.error("Audit log error:", err));

    return sendSuccess(res, 200, "Ticket refund request submitted successfully.", booking, requestId);
  } catch (err) {
    console.error("RefundTicket Error:", err);
    return sendError(res, 500, err.message || "Failed to request ticket refund.", requestId);
  }
};

/**
 * 12. POST /api/v1/flight-bookings/:flightBookingId/ssr
 * Add Special Service Request (SSR).
 */
export const AddSSR = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const tenantId = req.auth?.tenantId || "default";
    const userId = req.auth?.userId || req.auth?.id;
    const permissions = req.auth?.permissions || [];
    if (!permissions.includes("flight.ticket") && !permissions.includes("flight.book") && !permissions.includes("admin")) {
      return sendError(res, 403, "Permission denied.", requestId);
    }
    const { flightBookingId } = req.params;
    const { code, description, travelerId } = req.body;

    if (!code) {
      return sendError(res, 400, "code is required (e.g. WCHR, SPML, INFT).", requestId);
    }
    // "Supported SSR" — Wheelchair(WCHR), Special Meal(SPML), Infant(INFT),
    // Extra Seat(EXST), Medical(MEDA), Pet(PETC), Unaccompanied Minor(UMNR),
    // Other(OTHS). Previously any string was accepted.
    const { supportedSsrCodes } = getTicketingPolicyConfig();
    const normalizedCode = String(code).toUpperCase();
    if (!supportedSsrCodes.includes(normalizedCode)) {
      return sendError(res, 400, `Unsupported SSR code '${code}'. Must be one of: ${supportedSsrCodes.join(", ")}.`, requestId);
    }

    const booking = await FlightBookingModel.findOne({ _id: flightBookingId, tenantId });
    if (!booking) {
      return sendError(res, 404, "Flight booking not found.", requestId);
    }

    const ssrResult = await GdsIntegrationService.addSSR({
      provider: booking.provider,
      pnr: booking.pnr,
      code: normalizedCode,
      description,
      travelerId,
      tenantId
    });

    const ssrItem = {
      code: normalizedCode,
      description: description || normalizedCode,
      travelerId: travelerId || null,
      status: ssrResult.status || "CONFIRMED",
      createdAt: new Date()
    };

    booking.ssr.push(ssrItem);
    await booking.save();

    if (booking.travelPlanId) {
      await recordCanonicalDomainEvent({
        travelPlanId: booking.travelPlanId,
        tenantId,
        sourceModule: "GDSIntegration",
        aggregateType: "FlightBooking",
        aggregateId: booking._id,
        eventType: "SSRAdded",
        title: `SSR Added to PNR ${booking.pnr}`,
        description: `${normalizedCode}: ${ssrItem.description}`,
        actor: { userId: userId || "System", name: "Ticketing Desk", role: "Ticketing Agent" }
      });
    }

    publishEvent("SSRAdded", { flightBookingId: booking._id, code: normalizedCode, tenantId });

    AuditLogModel.create({
      tenantId, userId, action: "ADD_FLIGHT_SSR", module: "GDSIntegration",
      targetId: booking._id.toString(), details: { pnr: booking.pnr, code: normalizedCode }
    }).catch((err) => console.error("Audit log error:", err));

    return sendSuccess(res, 201, "SSR added successfully.", ssrItem, requestId);
  } catch (err) {
    console.error("AddSSR Error:", err);
    return sendError(res, 500, err.message || "Failed to add SSR.", requestId);
  }
};

/**
 * 13. POST /api/v1/flight-bookings/:flightBookingId/osi
 * Add Other Service Information (OSI).
 */
export const AddOSI = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const tenantId = req.auth?.tenantId || "default";
    const userId = req.auth?.userId || req.auth?.id;
    const permissions = req.auth?.permissions || [];
    if (!permissions.includes("flight.ticket") && !permissions.includes("flight.book") && !permissions.includes("admin")) {
      return sendError(res, 403, "Permission denied.", requestId);
    }
    const { flightBookingId } = req.params;
    const { code, remark, travelerId } = req.body;

    if (!remark) {
      return sendError(res, 400, "remark is required.", requestId);
    }
    // "OSI Management... Examples: VIP Passenger, Language Preference,
    // Special Handling, Corporate Traveler, Medical Notes" — previously any
    // string (or a fixed "CTCM" default) was accepted with no validation.
    const { supportedOsiTypes } = getTicketingPolicyConfig();
    if (!code || !supportedOsiTypes.includes(code)) {
      return sendError(res, 400, `code is required and must be one of: ${supportedOsiTypes.join(", ")}.`, requestId);
    }

    const booking = await FlightBookingModel.findOne({ _id: flightBookingId, tenantId });
    if (!booking) {
      return sendError(res, 404, "Flight booking not found.", requestId);
    }

    await GdsIntegrationService.addOSI({
      provider: booking.provider,
      pnr: booking.pnr,
      code,
      remark,
      travelerId,
      tenantId
    });

    const osiItem = {
      code,
      remark,
      travelerId: travelerId || null,
      createdAt: new Date()
    };

    booking.osi.push(osiItem);
    await booking.save();

    if (booking.travelPlanId) {
      await recordCanonicalDomainEvent({
        travelPlanId: booking.travelPlanId,
        tenantId,
        sourceModule: "GDSIntegration",
        aggregateType: "FlightBooking",
        aggregateId: booking._id,
        eventType: "OSIAdded",
        title: `OSI Added to PNR ${booking.pnr}`,
        description: `${code}: ${remark}`,
        actor: { userId: userId || "System", name: "Ticketing Desk", role: "Ticketing Agent" }
      });
    }

    publishEvent("OSIAdded", { flightBookingId: booking._id, code, tenantId });

    AuditLogModel.create({
      tenantId, userId, action: "ADD_FLIGHT_OSI", module: "GDSIntegration",
      targetId: booking._id.toString(), details: { pnr: booking.pnr, code }
    }).catch((err) => console.error("Audit log error:", err));

    return sendSuccess(res, 201, "OSI added successfully.", osiItem, requestId);
  } catch (err) {
    console.error("AddOSI Error:", err);
    return sendError(res, 500, err.message || "Failed to add OSI.", requestId);
  }
};

/**
 * 14. POST /api/v1/flight-bookings/:flightBookingId/emd
 * Issue Electronic Miscellaneous Document (EMD).
 */
export const IssueEMD = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const tenantId = req.auth?.tenantId || "default";
    const userId = req.auth?.userId || req.auth?.id;
    const permissions = req.auth?.permissions || [];
    if (!permissions.includes("flight.ticket") && !permissions.includes("flight.book") && !permissions.includes("admin")) {
      return sendError(res, 403, "Permission denied.", requestId);
    }
    const { flightBookingId } = req.params;
    const { serviceType, amount } = req.body;

    // "EMD Management... Examples: Extra Baggage, Seat Upgrade, Lounge
    // Access, Sports Equipment, Priority Boarding, Wi-Fi" — previously any
    // string (or a fixed default) and any amount (including 0) was accepted.
    const { supportedEmdTypes } = getTicketingPolicyConfig();
    if (!serviceType || !supportedEmdTypes.includes(serviceType)) {
      return sendError(res, 400, `serviceType is required and must be one of: ${supportedEmdTypes.join(", ")}.`, requestId);
    }
    const emdAmount = Number(amount);
    if (!Number.isFinite(emdAmount) || emdAmount <= 0) {
      return sendError(res, 400, "amount must be a positive number.", requestId);
    }

    const booking = await FlightBookingModel.findOne({ _id: flightBookingId, tenantId });
    if (!booking) {
      return sendError(res, 404, "Flight booking not found.", requestId);
    }

    const emdResult = await GdsIntegrationService.issueEMD({
      provider: booking.provider,
      pnr: booking.pnr,
      serviceType,
      amount: emdAmount,
      tenantId
    });

    const emdItem = {
      emdNumber: emdResult.emdNumber,
      serviceType,
      amount: emdAmount,
      status: "ISSUED",
      issuedAt: new Date()
    };

    booking.emd.push(emdItem);
    await booking.save();

    if (booking.travelPlanId) {
      await recordCanonicalDomainEvent({
        travelPlanId: booking.travelPlanId,
        tenantId,
        sourceModule: "GDSIntegration",
        aggregateType: "FlightBooking",
        aggregateId: booking._id,
        eventType: "EMDIssued",
        title: `EMD Issued for PNR ${booking.pnr}`,
        description: `${serviceType}: ${emdAmount} ${booking.currency}.`,
        actor: { userId: userId || "System", name: "Ticketing Desk", role: "Ticketing Agent" }
      });
    }

    publishEvent("EMDIssued", { flightBookingId: booking._id, emdNumber: emdResult.emdNumber, tenantId });

    AuditLogModel.create({
      tenantId, userId, action: "ISSUE_FLIGHT_EMD", module: "GDSIntegration",
      targetId: booking._id.toString(), details: { pnr: booking.pnr, emdNumber: emdResult.emdNumber, serviceType, amount: emdAmount }
    }).catch((err) => console.error("Audit log error:", err));

    return sendSuccess(res, 201, "EMD issued successfully.", emdItem, requestId);
  } catch (err) {
    console.error("IssueEMD Error:", err);
    return sendError(res, 500, err.message || "Failed to issue EMD.", requestId);
  }
};

export const GetFlightBookingHistory = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const tenantId = req.auth?.tenantId || "default";
    const permissions = req.auth?.permissions || [];
    if (!permissions.includes("flight.book") && !permissions.includes("flight.read") && !permissions.includes("admin")) {
      return sendError(res, 403, "Permission denied.", requestId);
    }
    const { flightBookingId } = req.params;
    const booking = await FlightBookingModel.findOne({ _id: flightBookingId, tenantId }).lean();
    if (!booking) {
      return sendError(res, 404, "Flight booking not found.", requestId);
    }
    // The schema field is `versionHistory`, not `statusHistory` — this
    // endpoint previously always returned an empty array regardless of how
    // many status changes/PNR events had actually happened.
    return sendSuccess(res, 200, "Booking history loaded.", { history: booking.versionHistory || [], pnr: booking.pnr }, requestId);
  } catch (err) {
    console.error("GetFlightBookingHistory Error:", err);
    return sendError(res, 500, err.message || "Failed to load history.", requestId);
  }
};

