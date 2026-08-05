import AmadeusHotelOfferService from "../services/AmadeusHotelOfferService.js";
import { sendError, sendSuccess } from "../utils/apiResponse.js";
import { createRequestId } from "../utils/authTokens.js";

const HOTEL_OFFER_PERMISSION = "travel.hotel.search";

const hasPermission = (permissions = []) => permissions.includes(HOTEL_OFFER_PERMISSION) || permissions.includes("hotel.search") || permissions.includes("admin");

/**
 * EXT-020 §5-13. GET /api/v1/integrations/amadeus/hotels/offers — live
 * room availability & pricing for a hotel already discovered via EXT-019.
 * The AI Assistant reaches this exclusively through its own
 * `get_hotel_room_offers` tool (AIToolRegistry.js), which calls
 * AmadeusHotelOfferService directly — never this HTTP layer, never
 * AmadeusAdapter, and never books a room (§14).
 */
export const GetAmadeusHotelOffers = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const tenantId = req.auth?.tenantId;
    const userId = req.auth?.userId || req.auth?.id;
    if (!tenantId) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req.auth?.permissions || [])) return sendError(res, 403, "Permission denied.", requestId);

    const { hotelId, checkInDate, checkOutDate, adults, children, rooms, currency } = req.query;
    const result = await AmadeusHotelOfferService.getOffers({ tenantId, userId, hotelId, checkInDate, checkOutDate, adults, children, rooms, currency, requestId });
    return sendSuccess(res, 200, "Hotel room offers retrieved successfully.", result.offers, requestId);
  } catch (err) {
    console.error("GetAmadeusHotelOffers Error:", err);
    const statusCode = err.status || 500;
    const code = err.code || "HOTEL_OFFERS_UNAVAILABLE";
    return sendError(res, statusCode, err.status ? err.message : "Hotel offers are temporarily unavailable. Please try again.", requestId, { code });
  }
};

/** §19 "RoomOfferViewed" log. */
export const RecordRoomOfferViewed = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const tenantId = req.auth?.tenantId;
    const userId = req.auth?.userId || req.auth?.id;
    if (!tenantId) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req.auth?.permissions || [])) return sendError(res, 403, "Permission denied.", requestId);

    const { hotelId, offerId } = req.body;
    const result = await AmadeusHotelOfferService.recordRoomViewed({ tenantId, userId, hotelId, offerId, requestId });
    return sendSuccess(res, 200, "View recorded.", result, requestId);
  } catch (err) {
    console.error("RecordRoomOfferViewed Error:", err);
    const statusCode = err.status || 500;
    const code = err.code || "VIEW_LOG_FAILED";
    return sendError(res, statusCode, err.status ? err.message : "Unable to record view. Please try again.", requestId, { code });
  }
};
