import AmadeusHotelCancellationService from "../services/AmadeusHotelCancellationService.js";
import { sendError, sendSuccess } from "../utils/apiResponse.js";
import { createRequestId } from "../utils/authTokens.js";

const HOTEL_CANCEL_PERMISSION = "travel.hotel.cancel";

const hasPermission = (permissions = []) => permissions.includes(HOTEL_CANCEL_PERMISSION) || permissions.includes("hotel.book") || permissions.includes("admin");

/**
 * EXT-024 §5-12. POST /api/v1/integrations/amadeus/hotels/bookings/:providerBookingId/cancel
 * — cancels a confirmed hotel reservation and computes refund eligibility/
 * penalty from real, stored cancellation-policy data (§3 "Not Responsible
 * For: Payment Refund Processing" — this determines WHAT the refund should
 * be; Finance/Payments actually moves money). The AI Assistant reaches
 * this exclusively through its own `propose_hotel_cancellation` tool,
 * which requires explicit human approval before ever being invoked —
 * never this HTTP layer, never AmadeusAdapter, directly.
 */
export const CancelAmadeusHotelBooking = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const tenantId = req.auth?.tenantId;
    const userId = req.auth?.userId || req.auth?.id;
    const userName = req.auth?.name;
    if (!tenantId) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req.auth?.permissions || [])) return sendError(res, 403, "Permission denied.", requestId);

    const { providerBookingId } = req.params;
    const { reason } = req.body;
    const result = await AmadeusHotelCancellationService.cancelBooking({ tenantId, userId, userName, providerBookingId, reason, requestId });
    return sendSuccess(res, 200, "Hotel booking cancelled successfully.", result, requestId);
  } catch (err) {
    console.error("CancelAmadeusHotelBooking Error:", err);
    const statusCode = err.status || 500;
    const code = err.code || "HOTEL_CANCELLATION_UNAVAILABLE";
    return sendError(res, statusCode, err.status ? err.message : "Hotel booking cancellation could not be completed. Please try again.", requestId, { code });
  }
};
