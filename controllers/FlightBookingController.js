import FlightBookingModel from "../models/FlightBookingModel.js";
import BookingHeaderModel from "../models/BookingHeaderModel.js";
import TravelPlanModel from "../models/TravelPlanModel.js";
import AuditLogModel from "../models/AuditLogmodel.js";
import GdsIntegrationService from "../services/GdsIntegrationService.js";
import { recordCanonicalDomainEvent } from "./TravelNotesTimelineController.js";
import { sendError, sendSuccess } from "../utils/apiResponse.js";
import { publishEvent } from "../utils/eventBus.js";
import { createRequestId } from "../utils/authTokens.js";

/**
 * 1. POST /api/v1/flight-bookings
 * Create live airline reservation (PNR) from Flight Offer.
 */
export const CreateFlightBooking = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const tenantId = req.auth?.tenantId || "default";
    const userId = req.auth?.userId || req.auth?.id;
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
    }

    // Step 1: Revalidate Offer with Provider
    const revalidation = await GdsIntegrationService.revalidateOffer({ offerId, provider });
    if (!revalidation.isValid) {
      return sendError(res, 400, "Flight offer is no longer valid or seats are sold out.", requestId);
    }

    // Step 2: Create PNR via GDS Provider Adapter
    const gdsResult = await GdsIntegrationService.createFlightBooking({
      offerId,
      provider,
      travelers,
      contact,
      totalPrice: revalidation.currentPrice || totalPrice,
      currency,
      tenantId
    });

    const ticketingDeadline = gdsResult.ticketingDeadline ? new Date(gdsResult.ticketingDeadline) : new Date(Date.now() + 24 * 60 * 60 * 1000);

    // Step 3: Create FlightBooking Model Document
    const flightBooking = await FlightBookingModel.create({
      tenantId,
      bookingId: bookingId || null,
      travelPlanId: travelPlanId || null,
      offerId,
      provider: gdsResult.provider || provider,
      pnr: gdsResult.pnr,
      providerBookingReference: gdsResult.providerBookingReference || gdsResult.pnr,
      status: "Reserved",
      totalPrice: gdsResult.totalPrice || totalPrice,
      currency,
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
        description: `Airline reservation confirmed via ${provider} for ${travelers.length} traveler(s).`,
        actor: { userId: userId || "System", name: "GDS Booking Agent", role: "Ops Coordinator" }
      });
    }

    publishEvent("FlightBookingCreated", {
      flightBookingId: flightBooking._id,
      pnr: gdsResult.pnr,
      tenantId,
      provider
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
        details: { pnr: gdsResult.pnr, provider }
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
    const { offerId, provider = "Amadeus" } = req.body;
    if (!offerId) {
      return sendError(res, 400, "offerId is required.", requestId);
    }

    const revalidation = await GdsIntegrationService.revalidateOffer({ offerId, provider });

    publishEvent("FlightBookingRevalidated", { offerId, provider, revalidation });

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
    const { flightBookingId } = req.params;
    const { reason = "Customer requested cancellation" } = req.body;

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

    booking.lastSynchronizedAt = new Date();
    await booking.save();

    publishEvent("ProviderBookingSynchronized", {
      flightBookingId: booking._id,
      pnr: booking.pnr,
      tenantId
    });

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
    const { flightBookingId } = req.params;
    const { paymentReference, remarks } = req.body;

    const booking = await FlightBookingModel.findOne({ _id: flightBookingId, tenantId });
    if (!booking) {
      return sendError(res, 404, "Flight booking not found.", requestId);
    }

    if (booking.ticketStatus === "Issued") {
      return sendError(res, 400, "Tickets have already been issued for this PNR.", requestId);
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
    const { flightBookingId } = req.params;
    const { reason = "Void requested within 24h window" } = req.body;

    const booking = await FlightBookingModel.findOne({ _id: flightBookingId, tenantId });
    if (!booking) {
      return sendError(res, 404, "Flight booking not found.", requestId);
    }

    if (booking.ticketStatus !== "Issued") {
      return sendError(res, 400, "Only issued tickets can be voided.", requestId);
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

    publishEvent("TicketVoided", {
      flightBookingId: booking._id,
      pnr: booking.pnr,
      tenantId
    });

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
    const { flightBookingId } = req.params;
    const { reason, newFlightOfferId, fareDiff = 0 } = req.body;

    if (!reason || !newFlightOfferId) {
      return sendError(res, 400, "reason and newFlightOfferId are required.", requestId);
    }

    const booking = await FlightBookingModel.findOne({ _id: flightBookingId, tenantId });
    if (!booking) {
      return sendError(res, 404, "Flight booking not found.", requestId);
    }

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
    await booking.save();

    publishEvent("TicketReissued", {
      flightBookingId: booking._id,
      pnr: booking.pnr,
      newTicketNumbers: reissueResult.newTicketNumbers,
      tenantId
    });

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
    const { flightBookingId } = req.params;
    const { reason = "Customer refund request", refundAmount = 0, penaltyFee = 0 } = req.body;

    const booking = await FlightBookingModel.findOne({ _id: flightBookingId, tenantId });
    if (!booking) {
      return sendError(res, 404, "Flight booking not found.", requestId);
    }

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

    await booking.save();

    publishEvent("RefundRequested", {
      flightBookingId: booking._id,
      pnr: booking.pnr,
      tenantId
    });

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
    const { flightBookingId } = req.params;
    const { code, description, travelerId } = req.body;

    if (!code) {
      return sendError(res, 400, "code is required (e.g. WCHR, VGML, INFT).", requestId);
    }

    const booking = await FlightBookingModel.findOne({ _id: flightBookingId, tenantId });
    if (!booking) {
      return sendError(res, 404, "Flight booking not found.", requestId);
    }

    const ssrResult = await GdsIntegrationService.addSSR({
      provider: booking.provider,
      pnr: booking.pnr,
      code,
      description,
      travelerId,
      tenantId
    });

    const ssrItem = {
      code,
      description: description || code,
      travelerId: travelerId || null,
      status: ssrResult.status || "CONFIRMED",
      createdAt: new Date()
    };

    booking.ssr.push(ssrItem);
    await booking.save();

    publishEvent("SSRAdded", { flightBookingId: booking._id, code, tenantId });

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
    const { flightBookingId } = req.params;
    const { code = "CTCM", remark, travelerId } = req.body;

    if (!remark) {
      return sendError(res, 400, "remark is required.", requestId);
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

    publishEvent("OSIAdded", { flightBookingId: booking._id, code, tenantId });

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
    const { flightBookingId } = req.params;
    const { serviceType = "Extra Baggage", amount = 15000 } = req.body;

    const booking = await FlightBookingModel.findOne({ _id: flightBookingId, tenantId });
    if (!booking) {
      return sendError(res, 404, "Flight booking not found.", requestId);
    }

    const emdResult = await GdsIntegrationService.issueEMD({
      provider: booking.provider,
      pnr: booking.pnr,
      serviceType,
      amount,
      tenantId
    });

    const emdItem = {
      emdNumber: emdResult.emdNumber,
      serviceType,
      amount,
      status: "ISSUED",
      issuedAt: new Date()
    };

    booking.emd.push(emdItem);
    await booking.save();

    publishEvent("EMDIssued", { flightBookingId: booking._id, emdNumber: emdResult.emdNumber, tenantId });

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
    const { flightBookingId } = req.params;
    const booking = await FlightBookingModel.findOne({ _id: flightBookingId, tenantId }).lean();
    if (!booking) {
      return sendError(res, 404, "Flight booking not found.", requestId);
    }
    return sendSuccess(res, 200, "Booking history loaded.", { history: booking.statusHistory || [], pnr: booking.pnr }, requestId);
  } catch (err) {
    console.error("GetFlightBookingHistory Error:", err);
    return sendError(res, 500, err.message || "Failed to load history.", requestId);
  }
};

