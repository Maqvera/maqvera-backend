import AmadeusFlightBookingService from "../services/AmadeusFlightBookingService.js";
import { sendError, sendSuccess } from "../utils/apiResponse.js";
import { createRequestId } from "../utils/authTokens.js";

const BOOKING_PERMISSION = "flight.book";

/**
 * EXT-004 §6-14. POST /api/v1/integrations/amadeus/flights/book — creates
 * the actual airline reservation (PNR) for a Travel Plan's Flight
 * Assignment. Note: this document's own literal endpoint path uses
 * "/integrations/amadeus/..." rather than EXT-002/003's "/external/...", an
 * inconsistency in the source documents themselves — honored exactly as
 * specified rather than silently normalized.
 */
export const CreateAmadeusFlightBooking = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const tenantId = req.auth?.tenantId;
    const userId = req.auth?.userId || req.auth?.id;
    const userName = req.auth?.name || "User";
    const branchId = req.auth?.branchId || "main";
    const permissions = req.auth?.permissions || [];

    if (!tenantId || !userId) {
      return sendError(res, 403, "Tenant and user context are required.", requestId);
    }
    if (!permissions.includes(BOOKING_PERMISSION) && !permissions.includes("admin")) {
      return sendError(res, 403, "Permission denied.", requestId);
    }

    const { travelPlanId, flightAssignmentId, flightOffer, travelers, contact } = req.body;
    if (!flightOffer) {
      return sendError(res, 400, "flightOffer is required (the exact object returned by EXT-002's search endpoint).", requestId, { code: "INVALID_FLIGHT_OFFER" });
    }

    const result = await AmadeusFlightBookingService.createBooking({
      tenantId, branchId, userId, userName, travelPlanId, flightAssignmentId, flightOffer, travelers, contact, requestId
    });

    if (result.priceChanged) {
      return sendSuccess(res, 200, result.message, result, requestId);
    }
    if (result.alreadyBooked) {
      return sendSuccess(res, 200, "This flight assignment is already booked.", result, requestId);
    }

    return sendSuccess(res, 201, "Airline reservation created successfully.", {
      flightBookingId: result.flightBookingId,
      airlineOrderId: result.airlineOrderId,
      pnr: result.pnr,
      bookingStatus: result.bookingStatus,
      ticketStatus: result.ticketStatus
    }, requestId);
  } catch (err) {
    console.error("CreateAmadeusFlightBooking Error:", err);
    const statusCode = err.status || 500;
    const code = err.code || "PROVIDER_UNAVAILABLE";
    return sendError(res, statusCode, err.status ? err.message : "Flight booking is temporarily unavailable. Please try again.", requestId, { code });
  }
};
