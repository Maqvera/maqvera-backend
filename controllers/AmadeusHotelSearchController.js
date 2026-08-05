import AmadeusHotelSearchService from "../services/AmadeusHotelSearchService.js";
import { sendError, sendSuccess } from "../utils/apiResponse.js";
import { createRequestId } from "../utils/authTokens.js";

const HOTEL_SEARCH_PERMISSION = "travel.hotel.search";

const hasPermission = (permissions = []) => permissions.includes(HOTEL_SEARCH_PERMISSION) || permissions.includes("hotel.search") || permissions.includes("admin");

/**
 * EXT-019 §5-13. GET /api/v1/integrations/amadeus/hotels/search — live
 * hotel discovery. The AI Assistant reaches this exclusively through its
 * own `search_hotels` tool (AIToolRegistry.js), which calls
 * AmadeusHotelSearchService directly — never this HTTP layer, never
 * AmadeusAdapter, and never books anything (§14).
 */
export const GetAmadeusHotelSearch = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const tenantId = req.auth?.tenantId;
    const userId = req.auth?.userId || req.auth?.id;
    if (!tenantId) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req.auth?.permissions || [])) return sendError(res, 403, "Permission denied.", requestId);

    const { cityCode, latitude, longitude, radius, radiusUnit, hotelName, amenities, ratings, chainCode, page, pageSize } = req.query;
    const result = await AmadeusHotelSearchService.getHotels({
      tenantId, userId, cityCode, latitude, longitude, radius, radiusUnit, hotelName, amenities, ratings, chainCode, page, pageSize, requestId
    });
    return sendSuccess(res, 200, "Hotels retrieved successfully.", result.hotels, requestId);
  } catch (err) {
    console.error("GetAmadeusHotelSearch Error:", err);
    const statusCode = err.status || 500;
    const code = err.code || "HOTEL_SEARCH_UNAVAILABLE";
    return sendError(res, statusCode, err.status ? err.message : "Hotel search is temporarily unavailable. Please try again.", requestId, { code });
  }
};

/** §19 "HotelViewed" log. */
export const RecordHotelViewed = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const tenantId = req.auth?.tenantId;
    const userId = req.auth?.userId || req.auth?.id;
    if (!tenantId) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req.auth?.permissions || [])) return sendError(res, 403, "Permission denied.", requestId);

    const { hotelId } = req.body;
    const result = await AmadeusHotelSearchService.recordHotelViewed({ tenantId, userId, hotelId, requestId });
    return sendSuccess(res, 200, "View recorded.", result, requestId);
  } catch (err) {
    console.error("RecordHotelViewed Error:", err);
    const statusCode = err.status || 500;
    const code = err.code || "VIEW_LOG_FAILED";
    return sendError(res, statusCode, err.status ? err.message : "Unable to record view. Please try again.", requestId, { code });
  }
};
