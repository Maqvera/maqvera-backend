import AnalyticsEngine from "../services/AnalyticsEngine.js";
import { sendError, sendSuccess } from "../utils/apiResponse.js";
import { createRequestId } from "../utils/authTokens.js";

/**
 * 1. GET /api/v1/travel/dashboard
 * Returns the primary operational dashboard metrics.
 */
export const GetPrimaryDashboard = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const tenantId = req.auth?.tenantId;
    const permissions = req.auth?.permissions || [];
    const branchId = req.query.branchId || "all";

    if (!tenantId) {
      return sendError(res, 403, "Tenant context is required.", requestId);
    }

    if (!permissions.includes("travel.read") && !permissions.includes("travel_plans.read") && !permissions.includes("admin")) {
      return sendError(res, 403, "Permission denied.", requestId);
    }

    const { data, fromCache } = await AnalyticsEngine.buildPrimaryDashboard({ tenantId, branchId });

    return sendSuccess(res, 200, "Primary dashboard retrieved successfully.", {
      data,
      meta: { fromCache, branchId, refreshedAt: new Date() }
    }, requestId);
  } catch (err) {
    console.error("GetPrimaryDashboard Error:", err);
    return sendError(res, 500, err.message || "Failed to fetch primary dashboard.", requestId);
  }
};

/**
 * 2. GET /api/v1/travel/dashboard/kpis
 * Returns operational KPIs.
 */
export const GetDashboardKPIs = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const tenantId = req.auth?.tenantId;
    const permissions = req.auth?.permissions || [];
    const branchId = req.query.branchId || "all";

    if (!tenantId) {
      return sendError(res, 403, "Tenant context is required.", requestId);
    }

    if (!permissions.includes("travel.read") && !permissions.includes("travel_plans.read") && !permissions.includes("admin")) {
      return sendError(res, 403, "Permission denied.", requestId);
    }

    const { data, fromCache } = await AnalyticsEngine.calculateKPIs({ tenantId, branchId });

    return sendSuccess(res, 200, "Dashboard KPIs retrieved successfully.", { data, meta: { fromCache } }, requestId);
  } catch (err) {
    console.error("GetDashboardKPIs Error:", err);
    return sendError(res, 500, err.message || "Failed to fetch dashboard KPIs.", requestId);
  }
};

/**
 * 3. GET /api/v1/travel/dashboard/trends
 * Returns historical operational trends.
 */
export const GetDashboardTrends = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const tenantId = req.auth?.tenantId;
    const permissions = req.auth?.permissions || [];
    const period = req.query.period || "7 Days";

    if (!tenantId) {
      return sendError(res, 403, "Tenant context is required.", requestId);
    }

    if (!permissions.includes("travel.read") && !permissions.includes("travel_plans.read") && !permissions.includes("admin")) {
      return sendError(res, 403, "Permission denied.", requestId);
    }

    const { data, fromCache } = await AnalyticsEngine.generateTrends({ tenantId, period });

    return sendSuccess(res, 200, "Dashboard trends retrieved successfully.", { data, meta: { fromCache } }, requestId);
  } catch (err) {
    console.error("GetDashboardTrends Error:", err);
    return sendError(res, 500, err.message || "Failed to fetch dashboard trends.", requestId);
  }
};

/**
 * 4. GET /api/v1/travel/dashboard/map
 * Returns live operational map data.
 */
export const GetDashboardMap = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const tenantId = req.auth?.tenantId;
    const permissions = req.auth?.permissions || [];

    if (!tenantId) {
      return sendError(res, 403, "Tenant context is required.", requestId);
    }

    if (!permissions.includes("travel.read") && !permissions.includes("travel_plans.read") && !permissions.includes("admin")) {
      return sendError(res, 403, "Permission denied.", requestId);
    }

    const { data, fromCache } = await AnalyticsEngine.getLiveMapData({ tenantId });

    return sendSuccess(res, 200, "Dashboard map data retrieved successfully.", { data, meta: { fromCache } }, requestId);
  } catch (err) {
    console.error("GetDashboardMap Error:", err);
    return sendError(res, 500, err.message || "Failed to fetch dashboard map data.", requestId);
  }
};

/**
 * 5. GET /api/v1/travel/dashboard/workload
 * Returns operational workload distribution.
 */
export const GetDashboardWorkload = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const tenantId = req.auth?.tenantId;
    const permissions = req.auth?.permissions || [];

    if (!tenantId) {
      return sendError(res, 403, "Tenant context is required.", requestId);
    }

    if (!permissions.includes("travel.read") && !permissions.includes("travel_plans.read") && !permissions.includes("admin")) {
      return sendError(res, 403, "Permission denied.", requestId);
    }

    const { data, fromCache } = await AnalyticsEngine.getWorkloadData({ tenantId });

    return sendSuccess(res, 200, "Dashboard workload data retrieved successfully.", { data, meta: { fromCache } }, requestId);
  } catch (err) {
    console.error("GetDashboardWorkload Error:", err);
    return sendError(res, 500, err.message || "Failed to fetch dashboard workload.", requestId);
  }
};

/**
 * 6. GET /api/v1/travel/dashboard/alerts
 * Returns operational alerts.
 */
export const GetDashboardAlerts = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const tenantId = req.auth?.tenantId;
    const permissions = req.auth?.permissions || [];

    if (!tenantId) {
      return sendError(res, 403, "Tenant context is required.", requestId);
    }

    if (!permissions.includes("travel.read") && !permissions.includes("travel_plans.read") && !permissions.includes("admin")) {
      return sendError(res, 403, "Permission denied.", requestId);
    }

    const { data, fromCache } = await AnalyticsEngine.getOperationalAlerts({ tenantId });

    return sendSuccess(res, 200, "Dashboard alerts retrieved successfully.", { data, meta: { fromCache } }, requestId);
  } catch (err) {
    console.error("GetDashboardAlerts Error:", err);
    return sendError(res, 500, err.message || "Failed to fetch dashboard alerts.", requestId);
  }
};
