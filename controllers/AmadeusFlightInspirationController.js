import AmadeusFlightInspirationService from "../services/AmadeusFlightInspirationService.js";
import { sendError, sendSuccess } from "../utils/apiResponse.js";
import { createRequestId } from "../utils/authTokens.js";

const INSPIRATION_PERMISSION = "travel.flight.search";

const hasPermission = (permissions = []) => permissions.includes(INSPIRATION_PERMISSION) || permissions.includes("flight.search") || permissions.includes("admin");

/**
 * EXT-015 §5-12. GET /api/v1/integrations/amadeus/flights/inspiration —
 * destination discovery. The AI Assistant reaches this exclusively through
 * its own `flight_inspiration` tool (AIToolRegistry.js), which calls
 * AmadeusFlightInspirationService directly — never this HTTP layer, and
 * never AmadeusAdapter — per the user's explicit "AI never gets direct
 * provider access" architecture mandate.
 */
export const GetAmadeusFlightInspiration = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const tenantId = req.auth?.tenantId;
    const userId = req.auth?.userId || req.auth?.id;
    if (!tenantId) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req.auth?.permissions || [])) return sendError(res, 403, "Permission denied.", requestId);

    const { origin, departureDate, returnDate, maxPrice, currency, nonStop, maxResults } = req.query;
    const result = await AmadeusFlightInspirationService.getInspiration({ tenantId, userId, origin, departureDate, returnDate, maxPrice, currency, nonStop, maxResults, requestId });
    return sendSuccess(res, 200, "Inspiration destinations retrieved successfully.", result.results, requestId);
  } catch (err) {
    console.error("GetAmadeusFlightInspiration Error:", err);
    const statusCode = err.status || 500;
    const code = err.code || "INSPIRATION_UNAVAILABLE";
    return sendError(res, statusCode, err.status ? err.message : "Flight inspiration is temporarily unavailable. Please try again.", requestId, { code });
  }
};

/** §19 "RecommendationViewed"/"RecommendationAccepted" feedback log. */
export const RecordInspirationFeedback = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const tenantId = req.auth?.tenantId;
    const userId = req.auth?.userId || req.auth?.id;
    if (!tenantId) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req.auth?.permissions || [])) return sendError(res, 403, "Permission denied.", requestId);

    const { origin, destination, action } = req.body;
    const result = await AmadeusFlightInspirationService.recordFeedback({ tenantId, userId, origin, destination, action, requestId });
    return sendSuccess(res, 200, "Feedback recorded.", result, requestId);
  } catch (err) {
    console.error("RecordInspirationFeedback Error:", err);
    const statusCode = err.status || 500;
    const code = err.code || "FEEDBACK_LOG_FAILED";
    return sendError(res, statusCode, err.status ? err.message : "Unable to record feedback. Please try again.", requestId, { code });
  }
};
