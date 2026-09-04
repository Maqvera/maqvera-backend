import mongoose from "mongoose";
import VisaAnalyticsEngine from "../services/VisaAnalyticsEngine.js";
import AuditLogModel from "../models/AuditLogmodel.js";
import ReportExportService from "../services/ReportExportService.js";
import { sendError, sendSuccess } from "../utils/apiResponse.js";
import { createRequestId } from "../utils/authTokens.js";
import { getAccessScope } from "../utils/accessScope.js";
import { toWidgetArray } from "../utils/dashboardWidgetContract.js";
import { publishEvent } from "../utils/eventBus.js";

// Reporting Platform Part 4 fix — DashboardWidgetContract projection
// (see utils/dashboardWidgetContract.js). Covers well-known Visa
// metric/KPI keys shared across several dashboardTypes; only keys
// actually present on a given response become widgets.
const VISA_WIDGET_MAP = {
  approvalRate: { title: "Approval Rate", type: "metric" },
  rejectionRate: { title: "Rejection Rate", type: "metric" },
  averageProcessingTimeDays: { title: "Avg Processing Time (Days)", type: "metric" },
  slaCompliancePct: { title: "SLA Compliance", type: "metric" },
  revenue: { title: "Revenue", type: "metric" },
  refundRatio: { title: "Refund Ratio", type: "metric" },
  officerProductivityPct: { title: "Officer Productivity", type: "metric" },
  customerSatisfaction: { title: "Customer Satisfaction", type: "metric" },
  embassySlaCompliancePct: { title: "Embassy SLA Compliance", type: "metric" },
  pendingVerification: { title: "Pending Verification", type: "metric" },
  verificationBacklog: { title: "Verification Backlog", type: "metric" },
  slaBreaches: { title: "SLA Breaches", type: "metric" },
  openIncidents: { title: "Open Incidents", type: "metric" },
  criticalIncidents: { title: "Critical Incidents", type: "metric" },
  highRiskCases: { title: "High Risk Cases", type: "metric" },
};

// Dashboard access is governed entirely by RBAC permissions (admin-configurable
// via /api/v1/roles), never by hardcoded role names — see
// docs/06-external-integrations/03-final-architecture-no-branches-rbac.md.
// Every user of the tenant sees the same company-wide dashboard data.
const hasManagementAccess = (permissions) => permissions.includes("visa.dashboard.management") || permissions.includes("admin");

const dashboardScope = (req) => {
  const accessScope = getAccessScope(req);
  const permissions = req.auth?.permissions || [];
  return {
    tenantId: accessScope?.tenantId || null,
    userId: req.auth?.userId || req.auth?.id || null,
    customerId: req.query.customerId || req.auth?.customerId || null,
    embassyId: req.query.embassyId || null,
    embassyName: req.query.embassyName || null,
    period: req.query.period || "7 Days",
    dateFrom: req.query.dateFrom || null,
    dateTo: req.query.dateTo || null,
    isManagement: hasManagementAccess(permissions),
    permissions,
  };
};

const handle = (method, message, { managementOnly = false, dashboardType = "unknown" } = {}) => async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = dashboardScope(req);
    if (!scope.tenantId) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!scope.permissions.includes("visa.read") && !scope.permissions.includes("admin")) {
      return sendError(res, 403, "visa.read permission required.", requestId);
    }
    if (managementOnly && !scope.isManagement) {
      return sendError(res, 403, "This dashboard requires the visa.dashboard.management permission.", requestId);
    }

    const result = await method.call(VisaAnalyticsEngine, scope);

    // "Security... Audit Access" — dashboard views were never logged. Fire
    // and forget; a logging failure must never block a read-only dashboard
    // response, and buffered writes against a disconnected DB would hang.
    if (mongoose.connection?.readyState === 1) {
      AuditLogModel.create({
        tenantId: scope.tenantId,
        userId: scope.userId || "system",
        action: "VIEW_DASHBOARD",
        module: "VisaAnalytics",
        details: { dashboardType, isManagement: scope.isManagement, fromCache: result.fromCache },
      }).catch((err) => console.error("Dashboard audit log error:", err));
    }

    // Reporting Platform Part 12 fix — usage-analytics hook (informational only).
    publishEvent("DashboardViewed", { tenantId: scope.tenantId, dashboardType, performedBy: scope.userId || null, module: "Visa" });

    return sendSuccess(
      res,
      200,
      message,
      {
        ...result.data,
        // Reporting Platform Part 4 fix — additive DashboardWidgetContract
        // projection; every existing field above is unchanged.
        widgets: toWidgetArray(result.data, VISA_WIDGET_MAP),
        meta: {
          fromCache: result.fromCache,
          generatedAt: result.data?.generatedAt || null,
        },
      },
      requestId
    );
  } catch (error) {
    return sendError(res, 500, error.message || "Dashboard unavailable.", requestId);
  }
};

/**
 * Reporting Platform Part 9/7 fix — Visa dashboards had no export
 * capability at all before this; reuses the SAME generic
 * ReportExportService.js Finance reports already use (Part 9). Same
 * managementOnly gate and audit-on-view logging as the matching live GET
 * dashboard, so an export can never surface data the caller couldn't see
 * live, and is logged the same way a view is.
 */
const handleExport = (method, dashboardType, { managementOnly = false } = {}) => async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = dashboardScope(req);
    if (!scope.tenantId) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!scope.permissions.includes("visa.read") && !scope.permissions.includes("admin")) {
      return sendError(res, 403, "visa.read permission required.", requestId);
    }
    if (managementOnly && !scope.isManagement) {
      return sendError(res, 403, "This dashboard requires the visa.dashboard.management permission.", requestId);
    }

    const result = await method.call(VisaAnalyticsEngine, scope);

    if (mongoose.connection?.readyState === 1) {
      AuditLogModel.create({
        tenantId: scope.tenantId, userId: scope.userId || "system", action: "EXPORT_DASHBOARD",
        module: "VisaAnalytics", details: { dashboardType, isManagement: scope.isManagement }
      }).catch((err) => console.error("Dashboard export audit log error:", err));
    }

    // Reporting Platform Part 12 fix — usage-analytics hook (informational only).
    publishEvent("DashboardExported", { tenantId: scope.tenantId, dashboardType, performedBy: scope.userId || null, module: "Visa" });

    const format = (req.query.format || "csv").toLowerCase();
    const formatMap = { csv: "CSV", xlsx: "Excel", excel: "Excel", pdf: "PDF", json: "JSON" };
    const resolvedFormat = formatMap[format];
    if (!resolvedFormat) return sendError(res, 400, `Invalid format "${format}". Must be one of: csv, xlsx, pdf, json.`, requestId);

    const report = { reportType: `Visa${dashboardType.charAt(0).toUpperCase()}${dashboardType.slice(1)}Dashboard`, data: result.data, generatedAt: new Date(), _id: Date.now() };

    if (resolvedFormat === "CSV") {
      const { content, mimeType, filename } = ReportExportService.generateCsv(report, { permissions: scope.permissions });
      res.setHeader("Content-Type", mimeType);
      res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
      return res.status(200).send(content);
    }
    if (resolvedFormat === "Excel") {
      const { buffer, mimeType, filename } = await ReportExportService.generateExcel(report, { permissions: scope.permissions });
      res.setHeader("Content-Type", mimeType);
      res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
      return res.status(200).send(buffer);
    }
    if (resolvedFormat === "PDF") {
      const buffer = await ReportExportService.generatePdfBuffer(report, { permissions: scope.permissions, tenantId: scope.tenantId });
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", `attachment; filename="${report.reportType}.pdf"`);
      return res.status(200).send(buffer);
    }
    return sendSuccess(res, 200, "Dashboard data retrieved successfully.", result.data, requestId);
  } catch (error) {
    return sendError(res, 500, error.message || "Dashboard export failed.", requestId);
  }
};

export const getVisaExecutiveDashboard = handle(
  VisaAnalyticsEngine.executiveDashboard,
  "Executive Visa dashboard retrieved successfully.",
  { managementOnly: true, dashboardType: "executive" }
);

export const getVisaOperationsDashboard = handle(
  VisaAnalyticsEngine.operationsDashboard,
  "Visa operations dashboard retrieved successfully.",
  { dashboardType: "operations" }
);

export const getVisaOfficerDashboard = handle(
  VisaAnalyticsEngine.officerDashboard,
  "Officer Visa dashboard retrieved successfully.",
  { dashboardType: "officer" }
);

export const getVisaEmbassyDashboard = handle(
  VisaAnalyticsEngine.embassyDashboard,
  "Embassy Visa dashboard retrieved successfully.",
  { dashboardType: "embassy" }
);

export const getVisaFinanceDashboard = handle(
  VisaAnalyticsEngine.financeDashboard,
  "Finance Visa dashboard retrieved successfully.",
  { managementOnly: true, dashboardType: "finance" }
);

export const getVisaCustomerDashboard = handle(
  VisaAnalyticsEngine.customerDashboard,
  "Customer Visa dashboard retrieved successfully.",
  { dashboardType: "customer" }
);

export const getVisaComplianceDashboard = handle(
  VisaAnalyticsEngine.complianceDashboard,
  "Compliance Visa dashboard retrieved successfully.",
  { managementOnly: true, dashboardType: "compliance" }
);

export const getVisaAiInsightsDashboard = handle(
  VisaAnalyticsEngine.aiInsightsDashboard,
  "AI insights Visa dashboard retrieved successfully.",
  { managementOnly: true, dashboardType: "ai-insights" }
);

export const getVisaDashboardKPIs = handle(
  VisaAnalyticsEngine.calculateKPIs,
  "Visa dashboard KPIs retrieved successfully.",
  { dashboardType: "kpis" }
);

export const getVisaDashboardTrends = handle(
  VisaAnalyticsEngine.generateTrends,
  "Visa dashboard trends retrieved successfully.",
  { dashboardType: "trends" }
);

// Export endpoints (Reporting Platform Part 9/7 fix) — one per exportable dashboard.
export const exportVisaOperationsDashboard = handleExport(VisaAnalyticsEngine.operationsDashboard, "operations");
export const exportVisaOfficerDashboard = handleExport(VisaAnalyticsEngine.officerDashboard, "officer");
export const exportVisaEmbassyDashboard = handleExport(VisaAnalyticsEngine.embassyDashboard, "embassy");
export const exportVisaFinanceDashboard = handleExport(VisaAnalyticsEngine.financeDashboard, "finance", { managementOnly: true });
export const exportVisaComplianceDashboard = handleExport(VisaAnalyticsEngine.complianceDashboard, "compliance", { managementOnly: true });
export const exportVisaExecutiveDashboard = handleExport(VisaAnalyticsEngine.executiveDashboard, "executive", { managementOnly: true });
