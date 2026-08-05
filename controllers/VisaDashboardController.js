import mongoose from "mongoose";
import VisaAnalyticsEngine from "../services/VisaAnalyticsEngine.js";
import AuditLogModel from "../models/AuditLogmodel.js";
import { sendError, sendSuccess } from "../utils/apiResponse.js";
import { createRequestId } from "../utils/authTokens.js";

const MANAGEMENT_ROLES = new Set([
  "administrator",
  "admin",
  "manager",
  "management",
  "director",
  "executive",
  "finance",
  "compliance",
]);

const resolveRole = (req) => String(req.auth?.role || req.auth?.roles?.[0] || "").toLowerCase();

const dashboardScope = (req) => {
  const role = resolveRole(req);
  const requestedBranch = req.query.branchId || req.auth?.branchId || "main";
  if (requestedBranch === "all" && !MANAGEMENT_ROLES.has(role)) {
    throw new Error("Branch-wide dashboard access requires a management role.");
  }
  return {
    tenantId: req.auth?.tenantId,
    branchId: requestedBranch,
    userId: req.auth?.userId || req.auth?.id || null,
    customerId: req.query.customerId || req.auth?.customerId || null,
    embassyId: req.query.embassyId || null,
    embassyName: req.query.embassyName || null,
    period: req.query.period || "7 Days",
    dateFrom: req.query.dateFrom || null,
    dateTo: req.query.dateTo || null,
    isManagement: MANAGEMENT_ROLES.has(role),
    role,
  };
};

const requireManagementRole = (role) => {
  if (!MANAGEMENT_ROLES.has(role)) {
    throw new Error("This dashboard requires a management role.");
  }
};

const handle = (method, message, { managementOnly = false, dashboardType = "unknown" } = {}) => async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = dashboardScope(req);
    if (!scope.tenantId) return sendError(res, 403, "Tenant context is required.", requestId);
    if (managementOnly) requireManagementRole(scope.role);

    const result = await method.call(VisaAnalyticsEngine, scope);

    // "Security... Audit Access" — dashboard views were never logged. Fire
    // and forget; a logging failure must never block a read-only dashboard
    // response, and buffered writes against a disconnected DB would hang.
    if (mongoose.connection?.readyState === 1) {
      AuditLogModel.create({
        tenantId: scope.tenantId,
        branchId: scope.branchId,
        userId: scope.userId || "system",
        action: "VIEW_DASHBOARD",
        module: "VisaAnalytics",
        details: { dashboardType, role: scope.role, fromCache: result.fromCache },
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
          branchId: scope.branchId,
          generatedAt: result.data?.generatedAt || null,
        },
      },
      requestId
    );
  } catch (error) {
    const statusCode = error.message.includes("management role") || error.message.includes("Branch-wide") ? 403 : 500;
    return sendError(res, statusCode, error.message || "Dashboard unavailable.", requestId);
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

export const getVisaBranchDashboard = handle(
  VisaAnalyticsEngine.branchDashboard,
  "Branch Visa dashboard retrieved successfully.",
  { dashboardType: "branch" }
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
