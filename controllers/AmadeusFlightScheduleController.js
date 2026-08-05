import AmadeusFlightScheduleService from "../services/AmadeusFlightScheduleService.js";
import { sendError, sendSuccess } from "../utils/apiResponse.js";
import { createRequestId } from "../utils/authTokens.js";

const FLIGHT_SCHEDULE_PERMISSION = "travel.flight.schedule.read";

/**
 * EXT-012 §5-11. GET /api/v1/integrations/amadeus/flights/schedules —
 * read-only planned flight schedule lookup for planning/itinerary support.
 */
export const GetAmadeusFlightSchedules = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const tenantId = req.auth?.tenantId;
    const userId = req.auth?.userId || req.auth?.id;
    const permissions = req.auth?.permissions || [];

    if (!tenantId) {
      return sendError(res, 403, "Tenant context is required.", requestId);
    }
    if (!permissions.includes(FLIGHT_SCHEDULE_PERMISSION) && !permissions.includes("flight.search") && !permissions.includes("admin")) {
      return sendError(res, 403, "Permission denied.", requestId);
    }

    const { origin, destination, departureDate, airlineCode, nonStop, maxResults } = req.query;

    const result = await AmadeusFlightScheduleService.getSchedules({
      tenantId, userId, origin, destination, departureDate, airlineCode, nonStop, maxResults, requestId
    });

    return sendSuccess(res, 200, "Flight schedules retrieved successfully.", result, requestId);
  } catch (err) {
    console.error("GetAmadeusFlightSchedules Error:", err);
    const statusCode = err.status || 500;
    const code = err.code || "PROVIDER_UNAVAILABLE";
    return sendError(res, statusCode, err.status ? err.message : "Flight schedule is temporarily unavailable. Please try again.", requestId, { code });
  }
};
