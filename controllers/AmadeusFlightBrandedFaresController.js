import AmadeusFlightBrandedFaresService from "../services/AmadeusFlightBrandedFaresService.js";
import { sendError, sendSuccess } from "../utils/apiResponse.js";
import { createRequestId } from "../utils/authTokens.js";

const BRANDED_FARES_PERMISSION = "travel.flight.search";

const hasPermission = (permissions = []) => permissions.includes(BRANDED_FARES_PERMISSION) || permissions.includes("flight.search") || permissions.includes("admin");

/**
 * EXT-016 §5-12. POST /api/v1/integrations/amadeus/flights/branded-fares —
 * fare-brand comparison for a previously-searched flight offer. The AI
 * Assistant reaches this exclusively through its own `compare_branded_fares`
 * tool (AIToolRegistry.js), which calls AmadeusFlightBrandedFaresService
 * directly — never this HTTP layer, never AmadeusAdapter.
 */
export const GetAmadeusBrandedFares = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const tenantId = req.auth?.tenantId;
    const userId = req.auth?.userId || req.auth?.id;
    if (!tenantId) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req.auth?.permissions || [])) return sendError(res, 403, "Permission denied.", requestId);

    const { flightOfferId, currency, passengers } = req.body;
    const result = await AmadeusFlightBrandedFaresService.getBrandedFares({ tenantId, userId, flightOfferId, currency, passengers, requestId });
    return sendSuccess(res, 200, "Branded fares retrieved successfully.", result.fares, requestId);
  } catch (err) {
    console.error("GetAmadeusBrandedFares Error:", err);
    const statusCode = err.status || 500;
    const code = err.code || "BRANDED_FARES_UNAVAILABLE";
    return sendError(res, statusCode, err.status ? err.message : "Branded fares are temporarily unavailable. Please try again.", requestId, { code });
  }
};

/** §19 "FareRecommended" — logs which fare a consumer ultimately recommended/selected. */
export const RecordBrandedFareRecommendation = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const tenantId = req.auth?.tenantId;
    const userId = req.auth?.userId || req.auth?.id;
    if (!tenantId) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req.auth?.permissions || [])) return sendError(res, 403, "Permission denied.", requestId);

    const { flightOfferId, fareName } = req.body;
    const result = await AmadeusFlightBrandedFaresService.recordRecommendation({ tenantId, userId, flightOfferId, fareName, requestId });
    return sendSuccess(res, 200, "Recommendation recorded.", result, requestId);
  } catch (err) {
    console.error("RecordBrandedFareRecommendation Error:", err);
    const statusCode = err.status || 500;
    const code = err.code || "RECOMMENDATION_LOG_FAILED";
    return sendError(res, statusCode, err.status ? err.message : "Unable to record recommendation. Please try again.", requestId, { code });
  }
};
