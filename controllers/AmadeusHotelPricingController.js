import AmadeusHotelPricingService from "../services/AmadeusHotelPricingService.js";
import { sendError, sendSuccess } from "../utils/apiResponse.js";
import { createRequestId } from "../utils/authTokens.js";

const HOTEL_PRICING_PERMISSION = "travel.hotel.book";

const hasPermission = (permissions = []) => permissions.includes(HOTEL_PRICING_PERMISSION) || permissions.includes("hotel.book") || permissions.includes("admin");

/**
 * EXT-021 §5-12. POST /api/v1/integrations/amadeus/hotels/pricing — live
 * re-verification of a hotel room offer's price/availability, mandatory
 * before EXT-022 booking creation. The AI Assistant reaches this
 * exclusively through its own `verify_hotel_offer_pricing` tool
 * (AIToolRegistry.js), which calls AmadeusHotelPricingService directly —
 * never this HTTP layer, never AmadeusAdapter, and never books anything.
 */
export const VerifyAmadeusHotelPricing = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const tenantId = req.auth?.tenantId;
    const userId = req.auth?.userId || req.auth?.id;
    if (!tenantId) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req.auth?.permissions || [])) return sendError(res, 403, "Permission denied.", requestId);

    const { hotelOfferId, currency } = req.body;
    const result = await AmadeusHotelPricingService.verifyPricing({ tenantId, userId, hotelOfferId, currency, requestId });
    return sendSuccess(res, 200, "Hotel offer pricing verified successfully.", result, requestId);
  } catch (err) {
    console.error("VerifyAmadeusHotelPricing Error:", err);
    const statusCode = err.status || 500;
    const code = err.code || "HOTEL_PRICING_UNAVAILABLE";
    return sendError(res, statusCode, err.status ? err.message : "Hotel pricing verification is temporarily unavailable. Please try again.", requestId, { code });
  }
};
