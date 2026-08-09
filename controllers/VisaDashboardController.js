import mongoose from "mongoose";
import VisaAnalyticsEngine from "../services/VisaAnalyticsEngine.js";
import AuditLogModel from "../models/AuditLogmodel.js";
import { sendError, sendSuccess } from "../utils/apiResponse.js";
import { createRequestId } from "../utils/authTokens.js";
import { getAccessScope } from "../utils/accessScope.js";

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

    return sendSuccess(
      res,
      200,
      message,
      {
        ...result.data,
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
