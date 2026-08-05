import AmadeusSeatSelectionService from "../services/AmadeusSeatSelectionService.js";
import { sendError, sendSuccess } from "../utils/apiResponse.js";
import { createRequestId } from "../utils/authTokens.js";

const SEAT_ASSIGN_PERMISSION = "travel.flight.seat.assign";

/**
 * EXT-009 §4-10. POST /api/v1/integrations/amadeus/seat-selection — assigns
 * airline seats to one or more travelers on an already-confirmed flight
 * order. Validates against EXT-008's live seat map before ever attempting
 * assignment.
 */
export const AssignAmadeusSeats = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const tenantId = req.auth?.tenantId;
    const userId = req.auth?.userId || req.auth?.id;
    const userName = req.auth?.name || "User";
    const branchId = req.auth?.branchId || "main";
    const permissions = req.auth?.permissions || [];

    if (!tenantId || !userId) {
      return sendError(res, 403, "Tenant and user context are required.", requestId);
    }
    if (!permissions.includes(SEAT_ASSIGN_PERMISSION) && !permissions.includes("flight.book") && !permissions.includes("admin")) {
      return sendError(res, 403, "Permission denied.", requestId);
    }

    const { flightOrderId, seatSelections, paymentApproved } = req.body;

    const result = await AmadeusSeatSelectionService.assignSeats({
      tenantId, branchId, userId, userName, flightOrderId, seatSelections, paymentApproved: Boolean(paymentApproved), requestId
    });

    return sendSuccess(res, 200, "Seats assigned successfully.", result, requestId);
  } catch (err) {
    console.error("AssignAmadeusSeats Error:", err);
    const statusCode = err.status || 500;
    const code = err.code || "PROVIDER_UNAVAILABLE";
    return sendError(res, statusCode, err.status ? err.message : "Seat assignment is temporarily unavailable. Please try again.", requestId, { code });
  }
};
