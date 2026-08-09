import FlightCheckInService from "../services/FlightCheckInService.js";
import { sendError, sendSuccess } from "../utils/apiResponse.js";
import { createRequestId } from "../utils/authTokens.js";

const CHECKIN_PERMISSION = "travel.flight.checkin";

/**
 * EXT-010 §5-11. POST /api/v1/integrations/airlines/check-in. Deliberately
 * NOT under /integrations/amadeus/... — this is airline-specific, not an
 * Amadeus capability, per this document's own explicit architectural
 * framing (a generic Airline Integration Layer, distinct from the Amadeus
 * EXT-series).
 */
export const PerformFlightCheckIn = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const tenantId = req.auth?.tenantId;
    const userId = req.auth?.userId || req.auth?.id;
    const userName = req.auth?.name || "User";
    const permissions = req.auth?.permissions || [];

    if (!tenantId || !userId) {
      return sendError(res, 403, "Tenant and user context are required.", requestId);
    }
    if (!permissions.includes(CHECKIN_PERMISSION) && !permissions.includes("flight.book") && !permissions.includes("admin")) {
      return sendError(res, 403, "Permission denied.", requestId);
    }

    const { bookingId, travelerIds } = req.body;

    const result = await FlightCheckInService.checkIn({ tenantId, userId, userName, bookingId, travelerIds, requestId });

    return sendSuccess(res, 200, result.supported === false ? "Online check-in is not available through this platform for this airline." : "Check-in completed successfully.", result, requestId);
  } catch (err) {
    console.error("PerformFlightCheckIn Error:", err);
    const statusCode = err.status || 500;
    const code = err.code || "PROVIDER_UNAVAILABLE";
    return sendError(res, statusCode, err.status ? err.message : "Check-in is temporarily unavailable. Please try again.", requestId, { code });
  }
};
