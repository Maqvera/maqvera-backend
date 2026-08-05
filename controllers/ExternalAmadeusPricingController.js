import AmadeusFlightPricingService from "../services/AmadeusFlightPricingService.js";
import { sendError, sendSuccess } from "../utils/apiResponse.js";
import { createRequestId } from "../utils/authTokens.js";

const PRICING_PERMISSION = "travel.external.flight.pricing";

/**
 * EXT-003 §5-10. POST /api/v1/external/amadeus/flights/pricing — verifies
 * the latest live fare for a flight offer selected from EXT-002's search
 * results before proceeding to booking. Never creates a booking.
 */
export const VerifyFlightPricing = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const tenantId = req.auth?.tenantId;
    const userId = req.auth?.userId || req.auth?.id;
    const permissions = req.auth?.permissions || [];

    // §6/§8 "JWT Required", "Tenant Validation", "Permission Validation".
    if (!tenantId || !userId) {
      return sendError(res, 403, "Tenant and user context are required.", requestId);
    }
    if (!permissions.includes(PRICING_PERMISSION) && !permissions.includes("admin")) {
      return sendError(res, 403, "Permission denied.", requestId);
    }

    const { flightOffer } = req.body;
    if (!flightOffer) {
      return sendError(res, 400, "flightOffer is required.", requestId, { code: "INVALID_FLIGHT_OFFER" });
    }

    const result = await AmadeusFlightPricingService.verifyPrice({ tenantId, userId, flightOffer, requestId });
    return sendSuccess(res, 200, "Live flight pricing verified successfully.", result, requestId);
  } catch (err) {
    console.error("VerifyFlightPricing Error:", err);
    // §13/§18 "No Raw Provider Errors" — every thrown error from the
    // service layer already carries a business-safe message and a
    // doc-defined `code`; a truly unexpected error still never leaks a raw
    // provider payload, just a generic message.
    const statusCode = err.status || 500;
    const code = err.code || "PROVIDER_UNAVAILABLE";
    return sendError(res, statusCode, err.status ? err.message : "Flight pricing verification is temporarily unavailable. Please try again.", requestId, { code });
  }
};
