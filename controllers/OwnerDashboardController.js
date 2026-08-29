import OwnerDashboardService from "../services/OwnerDashboardService.js";
import { sendSuccess, sendError } from "../utils/apiResponse.js";
import { createRequestId } from "../utils/authTokens.js";
import { getAccessScope } from "../utils/accessScope.js";

/**
 * GET /api/v1/dashboard/overview — PRD "CRM Feature Map by Phase" Phase 1
 * module 2. Single-screen agency owner view, separate from the ops-role
 * dashboards under /api/v1/travel/dashboard and /api/v1/dashboard/* (visa).
 */
export const getOwnerDashboardOverview = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);

    const permissions = req.auth?.permissions || [];
    if (!permissions.includes("dashboard.overview.read") && !permissions.includes("admin")) {
      return sendError(res, 403, "Permission denied.", requestId);
    }

    const overview = await OwnerDashboardService.getOverview(scope.tenantId);
    return sendSuccess(res, 200, "Owner dashboard overview retrieved successfully.", overview, requestId);
  } catch (error) {
    console.error("getOwnerDashboardOverview error:", error);
    return sendError(res, 500, error.message || "Failed to retrieve owner dashboard overview.", requestId);
  }
};
