import AmadeusHotelBookingService from "../services/AmadeusHotelBookingService.js";
import { sendError, sendSuccess } from "../utils/apiResponse.js";
import { createRequestId } from "../utils/authTokens.js";

const HOTEL_BOOKING_PERMISSION = "travel.hotel.book";

const hasPermission = (permissions = []) => permissions.includes(HOTEL_BOOKING_PERMISSION) || permissions.includes("hotel.book") || permissions.includes("admin");

/**
 * EXT-022 §5-13. POST /api/v1/integrations/amadeus/hotels/book — real
 * Amadeus hotel reservation creation, only after EXT-021 pricing
 * verification (enforced inside the service, not just documented). The AI
 * Assistant reaches this exclusively through its own `book_hotel_room`
 * tool, which requires explicit human confirmation before ever being
 * invoked — never this HTTP layer, never AmadeusAdapter, directly.
 */
export const CreateAmadeusHotelBooking = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const tenantId = req.auth?.tenantId;
    const userId = req.auth?.userId || req.auth?.id;
    const userName = req.auth?.name;
    if (!tenantId) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req.auth?.permissions || [])) return sendError(res, 403, "Permission denied.", requestId);

    const { travelPlanId, hotelOfferId, guests, contact, specialRequests, currency } = req.body;
    const result = await AmadeusHotelBookingService.createBooking({ tenantId, userId, userName, travelPlanId, hotelOfferId, guests, contact, specialRequests, currency, requestId });

    if (result.booked === false) {
      // Price changed since selection — a real, expected outcome, not a
      // server error (§17 "Price Changed").
      return sendSuccess(res, 200, result.message, result, requestId);
    }
    return sendSuccess(res, 201, "Hotel booking confirmed successfully.", result, requestId);
  } catch (err) {
    console.error("CreateAmadeusHotelBooking Error:", err);
    const statusCode = err.status || 500;
    const code = err.code || "HOTEL_BOOKING_UNAVAILABLE";
    return sendError(res, statusCode, err.status ? err.message : "Hotel booking could not be completed. Please try again.", requestId, { code });
  }
};
