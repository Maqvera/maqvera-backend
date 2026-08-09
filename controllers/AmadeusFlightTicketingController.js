import AmadeusFlightTicketingService from "../services/AmadeusFlightTicketingService.js";
import { sendError, sendSuccess } from "../utils/apiResponse.js";
import { createRequestId } from "../utils/authTokens.js";

const TICKETING_PERMISSION = "flight.ticket.issue";

/**
 * EXT-005 §5-14. POST /api/v1/integrations/amadeus/flights/ticket — issues
 * electronic airline tickets for an already-confirmed PNR (created via
 * EXT-004). Same "/integrations/amadeus/..." path prefix EXT-004 uses,
 * distinct from EXT-002/003's "/external/...".
 */
export const IssueAmadeusFlightTicket = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const tenantId = req.auth?.tenantId;
    const userId = req.auth?.userId || req.auth?.id;
    const userName = req.auth?.name || "User";
    const permissions = req.auth?.permissions || [];

    if (!tenantId || !userId) {
      return sendError(res, 403, "Tenant and user context are required.", requestId);
    }
    if (!permissions.includes(TICKETING_PERMISSION) && !permissions.includes("flight.book") && !permissions.includes("admin")) {
      return sendError(res, 403, "Permission denied.", requestId);
    }

    const { bookingId, pnr } = req.body;

    const result = await AmadeusFlightTicketingService.issueTicket({
      tenantId, userId, userName, bookingId, pnr, requestId
    });

    return sendSuccess(res, 200, "Electronic tickets issued successfully.", result, requestId);
  } catch (err) {
    console.error("IssueAmadeusFlightTicket Error:", err);
    const statusCode = err.status || 500;
    const code = err.code || "PROVIDER_UNAVAILABLE";
    return sendError(res, statusCode, err.status ? err.message : "Ticket issuance is temporarily unavailable. Please try again.", requestId, { code });
  }
};
