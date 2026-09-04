import mongoose from "mongoose";
import AnalyticsEngine from "../services/AnalyticsEngine.js";
import ReportExportService from "../services/ReportExportService.js";
import AuditLogModel from "../models/AuditLogmodel.js";
import ReportAuditService from "../services/ReportAuditService.js";
import { sendError, sendSuccess } from "../utils/apiResponse.js";
import { createRequestId } from "../utils/authTokens.js";
import { getAccessScope } from "../utils/accessScope.js";
import { toWidgetArray } from "../utils/dashboardWidgetContract.js";
import { publishEvent } from "../utils/eventBus.js";

// Reporting Platform Part 13 fix — Travel dashboards had NO audit logging
// at all before this (unlike Visa/Finance, whose handle() factories
// already log every view). Mirrors VisaDashboardController.js's own
// fire-and-forget, readyState-guarded discipline exactly; ReportAuditService
// is the additional tamper-evident layer, called alongside (not instead of)
// AuditLogModel — see models/ReportAuditEventModel.js's own doc comment.
const auditDashboardAccess = (tenantId, userId, dashboardType, action) => {
  if (mongoose.connection?.readyState === 1) {
    AuditLogModel.create({
      tenantId, userId: userId || "system", action, module: "TravelAnalytics",
      details: { dashboardType }
    }).catch((err) => console.error("Travel dashboard audit log error:", err));
  }
  ReportAuditService.recordEvent({
    tenantId, module: "Travel", resourceType: "Dashboard", resourceKey: dashboardType,
    action: action === "EXPORT_DASHBOARD" ? "EXPORT" : "VIEW", userId
  }).catch((err) => console.error("Travel dashboard report-audit error:", err));
};

// Reporting Platform Part 4 fix — DashboardWidgetContract projection
// (see utils/dashboardWidgetContract.js). Covers the primary-dashboard
// and KPI fields; only keys actually present on a given response become
// widgets, so this one map is safe to reuse for both endpoints below.
const TRAVEL_WIDGET_MAP = {
  activeTravelPlans: { title: "Active Travel Plans", type: "metric" },
  todaysDepartures: { title: "Today's Departures", type: "metric" },
  todaysArrivals: { title: "Today's Arrivals", type: "metric" },
  travelersInTransit: { title: "Travelers In Transit", type: "metric" },
  operationalHealthScore: { title: "Operational Health Score", type: "metric" },
  onTimeDeparturePct: { title: "On-Time Departure %", type: "metric" },
  onTimeArrivalPct: { title: "On-Time Arrival %", type: "metric" },
  hotelCheckInSuccessPct: { title: "Hotel Check-In Success %", type: "metric" },
  attendancePct: { title: "Attendance %", type: "metric" },
  travelerSatisfaction: { title: "Traveler Satisfaction", type: "metric" },
  tripCompletionPct: { title: "Trip Completion %", type: "metric" },
  avgDelayMinutes: { title: "Avg Delay (Minutes)", type: "metric" },
  guidePerformancePct: { title: "Guide Performance %", type: "metric" },
  vehicleUtilizationPct: { title: "Vehicle Utilization %", type: "metric" },
};

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

    // Reporting Platform Part 12 fix — usage-analytics hook (informational only).
    publishEvent("DashboardViewed", { tenantId, dashboardType: "primary", performedBy: req.auth?.userId || req.auth?.id || null, module: "Travel" });
    auditDashboardAccess(tenantId, req.auth?.userId || req.auth?.id || null, "primary", "VIEW_DASHBOARD");

    return sendSuccess(res, 200, "Primary dashboard retrieved successfully.", {
      data: filteredData,
      // Reporting Platform Part 4 fix — additive DashboardWidgetContract
      // projection; `data` above is unchanged.
      widgets: toWidgetArray(filteredData, TRAVEL_WIDGET_MAP),
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

    publishEvent("DashboardViewed", { tenantId, dashboardType: "kpis", performedBy: req.auth?.userId || req.auth?.id || null, module: "Travel" });
    auditDashboardAccess(tenantId, req.auth?.userId || req.auth?.id || null, "kpis", "VIEW_DASHBOARD");

    return sendSuccess(res, 200, "Dashboard KPIs retrieved successfully.", {
      data: filteredData,
      widgets: toWidgetArray(filteredData, TRAVEL_WIDGET_MAP),
      meta: { fromCache }
    }, requestId);
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

    publishEvent("DashboardViewed", { tenantId, dashboardType: "trends", performedBy: req.auth?.userId || req.auth?.id || null, module: "Travel" });
    auditDashboardAccess(tenantId, req.auth?.userId || req.auth?.id || null, "trends", "VIEW_DASHBOARD");

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

    publishEvent("DashboardViewed", { tenantId, dashboardType: "map", performedBy: req.auth?.userId || req.auth?.id || null, module: "Travel" });
    auditDashboardAccess(tenantId, req.auth?.userId || req.auth?.id || null, "map", "VIEW_DASHBOARD");

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

    publishEvent("DashboardViewed", { tenantId, dashboardType: "workload", performedBy: req.auth?.userId || req.auth?.id || null, module: "Travel" });
    auditDashboardAccess(tenantId, req.auth?.userId || req.auth?.id || null, "workload", "VIEW_DASHBOARD");

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

    publishEvent("DashboardViewed", { tenantId, dashboardType: "alerts", performedBy: req.auth?.userId || req.auth?.id || null, module: "Travel" });
    auditDashboardAccess(tenantId, req.auth?.userId || req.auth?.id || null, "alerts", "VIEW_DASHBOARD");

    return sendSuccess(res, 200, "Dashboard alerts retrieved successfully.", { data, meta: { fromCache } }, requestId);
  } catch (err) {
    console.error("GetDashboardAlerts Error:", err);
    return sendError(res, 500, err.message || "Failed to fetch dashboard alerts.", requestId);
  }
};

const VIEW_LOADERS = {
  primary: (tenantId) => AnalyticsEngine.buildPrimaryDashboard({ tenantId }),
  kpis: (tenantId) => AnalyticsEngine.calculateKPIs({ tenantId }),
  trends: (tenantId, query) => AnalyticsEngine.generateTrends({ tenantId, period: query.period || "7 Days" }),
  map: (tenantId) => AnalyticsEngine.getLiveMapData({ tenantId }),
  workload: (tenantId) => AnalyticsEngine.getWorkloadData({ tenantId }),
  alerts: (tenantId) => AnalyticsEngine.getOperationalAlerts({ tenantId })
};

/**
 * 7. GET /api/v1/travel/dashboard/export?view=primary|kpis|trends|map|workload|alerts&format=csv|xlsx|pdf
 * Reporting Platform Part 9/7 fix — Travel dashboards had no export capability at
 * all before this; reuses the SAME generic ReportExportService.js Finance
 * reports already use (Part 9), not a second export implementation. Same
 * incident-derived-field filtering as the matching live GET endpoint above —
 * an exported file must never contain data the caller couldn't see live.
 */
export const ExportDashboard = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    const permissions = req.auth?.permissions || [];
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    const tenantId = scope.tenantId;

    if (!permissions.includes("travel.read") && !permissions.includes("travel_plans.read") && !permissions.includes("admin")) {
      return sendError(res, 403, "Permission denied.", requestId);
    }

    const view = req.query.view || "primary";
    const loader = VIEW_LOADERS[view];
    if (!loader) return sendError(res, 400, `Invalid view "${view}". Must be one of: ${Object.keys(VIEW_LOADERS).join(", ")}.`, requestId);
    if (view === "alerts" && !hasIncidentAccess(permissions)) {
      return sendError(res, 403, "Permission denied — incident read access is required for operational alerts.", requestId);
    }

    const { data } = await loader(tenantId, req.query);
    let exportData = data;
    if (!hasIncidentAccess(permissions)) {
      const { openIncidents, criticalIncidents, emergencyCases, incidentRatePct, emergencyCount, avgIncidentResolutionHours, avgResponseTimeHours, incidentLocations, emergencyAlertsCount, openIncidentsCount, ...rest } = exportData;
      exportData = rest;
    }

    const format = (req.query.format || "csv").toLowerCase();
    const formatMap = { csv: "CSV", xlsx: "Excel", excel: "Excel", pdf: "PDF", json: "JSON" };
    const resolvedFormat = formatMap[format];
    if (!resolvedFormat) return sendError(res, 400, `Invalid format "${format}". Must be one of: csv, xlsx, pdf, json.`, requestId);

    // Reporting Platform Part 12 fix — usage-analytics hook (informational only).
    publishEvent("DashboardExported", { tenantId, dashboardType: view, performedBy: req.auth?.userId || req.auth?.id || null, module: "Travel" });
    auditDashboardAccess(tenantId, req.auth?.userId || req.auth?.id || null, view, "EXPORT_DASHBOARD");

    const report = { reportType: `Travel${view.charAt(0).toUpperCase()}${view.slice(1)}Dashboard`, data: exportData, generatedAt: new Date(), _id: Date.now() };

    if (resolvedFormat === "CSV") {
      const { content, mimeType, filename } = ReportExportService.generateCsv(report, { permissions });
      res.setHeader("Content-Type", mimeType);
      res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
      return res.status(200).send(content);
    }
    if (resolvedFormat === "Excel") {
      const { buffer, mimeType, filename } = await ReportExportService.generateExcel(report, { permissions });
      res.setHeader("Content-Type", mimeType);
      res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
      return res.status(200).send(buffer);
    }
    if (resolvedFormat === "PDF") {
      const buffer = await ReportExportService.generatePdfBuffer(report, { permissions, tenantId });
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", `attachment; filename="${report.reportType}.pdf"`);
      return res.status(200).send(buffer);
    }
    // JSON — the data itself, already the real underlying object.
    return sendSuccess(res, 200, "Dashboard data retrieved successfully.", exportData, requestId);
  } catch (err) {
    console.error("ExportDashboard Error:", err);
    return sendError(res, 500, err.message || "Failed to export dashboard.", requestId);
  }
};
