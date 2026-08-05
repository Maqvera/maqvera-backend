import FlightScheduleSyncService from "../services/FlightScheduleSyncService.js";
import { sendError, sendSuccess } from "../utils/apiResponse.js";
import { createRequestId } from "../utils/authTokens.js";

const SYNC_TRIGGER_PERMISSION = "travel.flight.sync.trigger";

const hasPermission = (permissions = []) => permissions.includes(SYNC_TRIGGER_PERMISSION) || permissions.includes("travel.flight.read") || permissions.includes("admin");

/**
 * EXT-018 §5 "Trigger Sources — Manual Sync, Booking Refresh, Travel
 * Dashboard, Operations Screen." POST /api/v1/integrations/amadeus/flights/schedule-sync
 * runs the same sync cycle the background scheduler runs automatically —
 * scoped strictly to the caller's own tenant.
 */
export const TriggerFlightScheduleSync = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const tenantId = req.auth?.tenantId;
    if (!tenantId) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req.auth?.permissions || [])) return sendError(res, 403, "Permission denied.", requestId);

    const tier = req.body?.tier === "high" ? "high" : "standard";
    const result = await FlightScheduleSyncService.syncTenant({ tenantId, tier });
    return sendSuccess(res, 200, "Flight schedule synchronization completed.", result, requestId);
  } catch (err) {
    console.error("TriggerFlightScheduleSync Error:", err);
    return sendError(res, 500, "Flight schedule synchronization failed. Please try again.", requestId);
  }
};
