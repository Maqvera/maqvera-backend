import AmadeusSeatMapService from "../services/AmadeusSeatMapService.js";
import { sendError, sendSuccess } from "../utils/apiResponse.js";
import { createRequestId } from "../utils/authTokens.js";

const SEAT_MAP_PERMISSION = "travel.flight.read";

/**
 * EXT-008 §4-10. GET /api/v1/integrations/amadeus/seat-map/:flightOrderId —
 * read-only live seat map for a confirmed flight order. Never mutates
 * anything; seat *selection* (actually reserving a seat) is EXT-009's job.
 */
export const GetAmadeusFlightOrderSeatMap = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const tenantId = req.auth?.tenantId;
    const permissions = req.auth?.permissions || [];

    if (!tenantId) {
      return sendError(res, 403, "Tenant context is required.", requestId);
    }
    // `flight.read`/`flight.book` already gate read access to the same
    // underlying FlightBookingModel elsewhere in this codebase (API-006C/D);
    // accepted here too so an operator who can already view a booking can
    // also view its seat map, alongside the doc's own named permission.
    if (!permissions.includes(SEAT_MAP_PERMISSION) && !permissions.includes("flight.read") && !permissions.includes("flight.book") && !permissions.includes("admin")) {
      return sendError(res, 403, "Permission denied.", requestId);
    }

    const { flightOrderId } = req.params;
    const { travelerId, segmentId } = req.query;

    const result = await AmadeusSeatMapService.getSeatMap({ tenantId, flightOrderId, travelerId, segmentId, requestId });

    return sendSuccess(res, 200, "Seat map retrieved successfully.", result, requestId);
  } catch (err) {
    console.error("GetAmadeusFlightOrderSeatMap Error:", err);
    const statusCode = err.status || 500;
    const code = err.code || "PROVIDER_UNAVAILABLE";
    return sendError(res, statusCode, err.status ? err.message : "Seat map is temporarily unavailable. Please try again.", requestId, { code });
  }
};
