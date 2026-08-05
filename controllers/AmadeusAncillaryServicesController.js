import AmadeusAncillaryServicesService from "../services/AmadeusAncillaryServicesService.js";
import { sendError, sendSuccess } from "../utils/apiResponse.js";
import { createRequestId } from "../utils/authTokens.js";

const ANCILLARY_PERMISSION = "travel.flight.search";

const hasPermission = (permissions = []) => permissions.includes(ANCILLARY_PERMISSION) || permissions.includes("flight.search") || permissions.includes("admin");

/**
 * EXT-017 §5-12. POST /api/v1/integrations/amadeus/flights/ancillaries —
 * priced optional add-on services for a previously-searched flight offer.
 * The AI Assistant reaches this exclusively through its own
 * `recommend_ancillary_services` tool (AIToolRegistry.js), which calls
 * AmadeusAncillaryServicesService directly — never this HTTP layer, never
 * AmadeusAdapter, and never purchases anything automatically (§14).
 */
export const GetAmadeusAncillaryServices = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const tenantId = req.auth?.tenantId;
    const userId = req.auth?.userId || req.auth?.id;
    if (!tenantId) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req.auth?.permissions || [])) return sendError(res, 403, "Permission denied.", requestId);

    const { flightOfferId, currency, passengers } = req.body;
    const result = await AmadeusAncillaryServicesService.getAncillaries({ tenantId, userId, flightOfferId, currency, passengers, requestId });
    return sendSuccess(res, 200, "Ancillary services retrieved successfully.", result.services, requestId);
  } catch (err) {
    console.error("GetAmadeusAncillaryServices Error:", err);
    const statusCode = err.status || 500;
    const code = err.code || "ANCILLARY_SERVICES_UNAVAILABLE";
    return sendError(res, statusCode, err.status ? err.message : "Ancillary services are temporarily unavailable. Please try again.", requestId, { code });
  }
};

/** §19 "AncillarySelected"/"BookingPriceUpdated" selection log. */
export const RecordAncillarySelection = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const tenantId = req.auth?.tenantId;
    const userId = req.auth?.userId || req.auth?.id;
    if (!tenantId) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req.auth?.permissions || [])) return sendError(res, 403, "Permission denied.", requestId);

    const { flightOfferId, selectedServiceIds, currency } = req.body;
    const result = await AmadeusAncillaryServicesService.recordSelection({ tenantId, userId, flightOfferId, selectedServiceIds, currency, requestId });
    return sendSuccess(res, 200, "Selection recorded.", result, requestId);
  } catch (err) {
    console.error("RecordAncillarySelection Error:", err);
    const statusCode = err.status || 500;
    const code = err.code || "SELECTION_LOG_FAILED";
    return sendError(res, statusCode, err.status ? err.message : "Unable to record selection. Please try again.", requestId, { code });
  }
};
