import AnalyticsEngine from "../services/AnalyticsEngine.js";
import { sendError, sendSuccess } from "../utils/apiResponse.js";
import { createRequestId } from "../utils/authTokens.js";
import { getAccessScope } from "../utils/accessScope.js";

// Business Rule: "Supports role-based widgets... Widgets filtered
// automatically." No explicit role-to-widget mapping is given anywhere in
// the doc (only role NAMES are listed), so building a full, speculative
// access matrix would mean guessing. What IS unambiguous: Incident
// Management (Part 8) already established a real, separate `incidents.read`
// permission boundary distinct from `travel.read` — this reuses that
// existing boundary consistently, so a caller without incident-read access
// doesn't see incident-derived counts inside the dashboards either.
const hasIncidentAccess = (permissions) => permissions.includes("incidents.read") || permissions.includes("admin");

/**
 * 1. GET /api/v1/travel/dashboard
 * Returns the primary operational dashboard metrics.
 */
export const GetPrimaryDashboard = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    const permissions = req.auth?.permissions || [];

    if (!scope) {
      return sendError(res, 403, "Tenant context is required.", requestId);
    }
    const tenantId = scope.tenantId;

    if (!permissions.includes("travel.read") && !permissions.includes("travel_plans.read") && !permissions.includes("admin")) {
      return sendError(res, 403, "Permission denied.", requestId);
    }

    const { data, fromCache } = await AnalyticsEngine.buildPrimaryDashboard({ tenantId });

    let filteredData = { ...data };
    if (!hasIncidentAccess(permissions)) {
      const { openIncidents, criticalIncidents, emergencyCases, ...rest } = filteredData;
      filteredData = rest;
      filteredData.aiInsights = (filteredData.aiInsights || []).filter((i) => !i.insightType?.startsWith("IncidentTrend"));
    }

    // Business Rule: "Supports configurable widgets." Endpoint-level
    // selection (primary/kpis/trends/map/workload/alerts, each independently
    // cacheable) is the primary way this is satisfied; this optional
    // ?fields= filter adds field-level composability within the primary
    // dashboard itself — real and dynamic, not a fixed subset.
    if (req.query.fields) {
      const requestedFields = req.query.fields.split(",").map((f) => f.trim()).filter(Boolean);
      const narrowed = {};
      requestedFields.forEach((f) => {
        if (filteredData[f] !== undefined) narrowed[f] = filteredData[f];
      });
      narrowed.dataAvailable = filteredData.dataAvailable;
      filteredData = narrowed;
    }

    return sendSuccess(res, 200, "Primary dashboard retrieved successfully.", {
      data: filteredData,
      meta: { fromCache, refreshedAt: new Date() }
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
    const scope = getAccessScope(req);
    const permissions = req.auth?.permissions || [];

    if (!scope) {
      return sendError(res, 403, "Tenant context is required.", requestId);
    }
    const tenantId = scope.tenantId;

    if (!permissions.includes("travel.read") && !permissions.includes("travel_plans.read") && !permissions.includes("admin")) {
      return sendError(res, 403, "Permission denied.", requestId);
    }

    const { data, fromCache } = await AnalyticsEngine.calculateKPIs({ tenantId });

    let filteredData = data;
    if (!hasIncidentAccess(permissions)) {
      const { incidentRatePct, emergencyCount, avgIncidentResolutionHours, avgResponseTimeHours, ...rest } = data;
      filteredData = rest;
    }

    return sendSuccess(res, 200, "Dashboard KPIs retrieved successfully.", { data: filteredData, meta: { fromCache } }, requestId);
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
    const scope = getAccessScope(req);
    const permissions = req.auth?.permissions || [];
    const period = req.query.period || "7 Days";

    if (!scope) {
      return sendError(res, 403, "Tenant context is required.", requestId);
    }
    const tenantId = scope.tenantId;

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
    const scope = getAccessScope(req);
    const permissions = req.auth?.permissions || [];

    if (!scope) {
      return sendError(res, 403, "Tenant context is required.", requestId);
    }
    const tenantId = scope.tenantId;

    if (!permissions.includes("travel.read") && !permissions.includes("travel_plans.read") && !permissions.includes("admin")) {
      return sendError(res, 403, "Permission denied.", requestId);
    }

    const { data, fromCache } = await AnalyticsEngine.getLiveMapData({ tenantId });

    let filteredData = data;
    if (!hasIncidentAccess(permissions)) {
      const { incidentLocations, emergencyAlertsCount, ...rest } = data;
      filteredData = rest;
    }

    return sendSuccess(res, 200, "Dashboard map data retrieved successfully.", { data: filteredData, meta: { fromCache } }, requestId);
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
    const scope = getAccessScope(req);
    const permissions = req.auth?.permissions || [];

    if (!scope) {
      return sendError(res, 403, "Tenant context is required.", requestId);
    }
    const tenantId = scope.tenantId;

    if (!permissions.includes("travel.read") && !permissions.includes("travel_plans.read") && !permissions.includes("admin")) {
      return sendError(res, 403, "Permission denied.", requestId);
    }

    const { data, fromCache } = await AnalyticsEngine.getWorkloadData({ tenantId });

    let filteredData = data;
    if (!hasIncidentAccess(permissions)) {
      const { openIncidentsCount, ...rest } = data;
      filteredData = rest;
    }

    return sendSuccess(res, 200, "Dashboard workload data retrieved successfully.", { data: filteredData, meta: { fromCache } }, requestId);
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
    const scope = getAccessScope(req);
    const permissions = req.auth?.permissions || [];

    if (!scope) {
      return sendError(res, 403, "Tenant context is required.", requestId);
    }
    const tenantId = scope.tenantId;

    if (!permissions.includes("travel.read") && !permissions.includes("travel_plans.read") && !permissions.includes("admin")) {
      return sendError(res, 403, "Permission denied.", requestId);
    }
    // This endpoint's entire content is incident-derived — unlike the other
    // 5 dashboard endpoints, there's nothing meaningful left to return
    // after filtering, so it's gated outright rather than field-filtered.
    if (!hasIncidentAccess(permissions)) {
      return sendError(res, 403, "Permission denied — incident read access is required for operational alerts.", requestId);
    }

    const { data, fromCache } = await AnalyticsEngine.getOperationalAlerts({ tenantId });

    return sendSuccess(res, 200, "Dashboard alerts retrieved successfully.", { data, meta: { fromCache } }, requestId);
  } catch (err) {
    console.error("GetDashboardAlerts Error:", err);
    return sendError(res, 500, err.message || "Failed to fetch dashboard alerts.", requestId);
  }
};
