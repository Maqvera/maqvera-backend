import AmadeusHotelBookingRetrievalService from "../services/AmadeusHotelBookingRetrievalService.js";
import { sendError, sendSuccess } from "../utils/apiResponse.js";
import { createRequestId } from "../utils/authTokens.js";

const HOTEL_READ_PERMISSION = "travel.hotel.read";

const hasPermission = (permissions = []) => permissions.includes(HOTEL_READ_PERMISSION) || permissions.includes("hotel.search") || permissions.includes("admin");

/**
 * EXT-023 §5-11. GET /api/v1/integrations/amadeus/hotels/bookings/:providerBookingId
 * — read-only retrieval/synchronization of an existing hotel reservation
 * created via EXT-022. The AI Assistant reaches this exclusively through
 * its own `get_hotel_booking_details` tool (AIToolRegistry.js), which
 * calls AmadeusHotelBookingRetrievalService directly — never this HTTP
 * layer, never AmadeusAdapter, and never modifies anything (§14).
 */
export const GetAmadeusHotelBooking = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const tenantId = req.auth?.tenantId;
    const userId = req.auth?.userId || req.auth?.id;
    if (!tenantId) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req.auth?.permissions || [])) return sendError(res, 403, "Permission denied.", requestId);

    const { providerBookingId } = req.params;
    const result = await AmadeusHotelBookingRetrievalService.getBooking({ tenantId, userId, providerBookingId, requestId });
    return sendSuccess(res, 200, "Hotel booking retrieved successfully.", result, requestId);
  } catch (err) {
    console.error("GetAmadeusHotelBooking Error:", err);
    const statusCode = err.status || 500;
    const code = err.code || "HOTEL_BOOKING_RETRIEVAL_UNAVAILABLE";
    return sendError(res, statusCode, err.status ? err.message : "Hotel booking retrieval is temporarily unavailable. Please try again.", requestId, { code });
  }
};
