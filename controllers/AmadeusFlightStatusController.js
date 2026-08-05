import AmadeusFlightStatusService from "../services/AmadeusFlightStatusService.js";
import { sendError, sendSuccess } from "../utils/apiResponse.js";
import { createRequestId } from "../utils/authTokens.js";

const FLIGHT_STATUS_PERMISSION = "travel.flight.read";

/**
 * EXT-011 §5-11. GET /api/v1/integrations/amadeus/flights/status — live,
 * read-only operational status for a specific flight/date.
 */
export const GetAmadeusFlightStatus = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const tenantId = req.auth?.tenantId;
    const userId = req.auth?.userId || req.auth?.id;
    const userName = req.auth?.name || "User";
    const permissions = req.auth?.permissions || [];

    if (!tenantId) {
      return sendError(res, 403, "Tenant context is required.", requestId);
    }
    if (!permissions.includes(FLIGHT_STATUS_PERMISSION) && !permissions.includes("flight.read") && !permissions.includes("flight.book") && !permissions.includes("admin")) {
      return sendError(res, 403, "Permission denied.", requestId);
    }

    const { flightNumber, departureDate, airlineCode, originAirport, destinationAirport } = req.query;

    const result = await AmadeusFlightStatusService.getStatus({
      tenantId, userId, userName, flightNumber, airlineCode, departureDate, originAirport, destinationAirport, requestId
    });

    return sendSuccess(res, 200, "Flight status retrieved successfully.", result, requestId);
  } catch (err) {
    console.error("GetAmadeusFlightStatus Error:", err);
    const statusCode = err.status || 500;
    const code = err.code || "PROVIDER_UNAVAILABLE";
    return sendError(res, statusCode, err.status ? err.message : "Flight status is temporarily unavailable. Please try again.", requestId, { code });
  }
};
