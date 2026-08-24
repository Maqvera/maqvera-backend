import mongoose from "mongoose";
import FinanceAnalyticsEngine from "../services/FinanceAnalyticsEngine.js";
import AuditLogModel from "../models/AuditLogmodel.js";
import { sendError, sendSuccess } from "../utils/apiResponse.js";
import { createRequestId } from "../utils/authTokens.js";
import { getAccessScope } from "../utils/accessScope.js";
import { publishEvent } from "../utils/eventBus.js";
import { toWidgetArray } from "../utils/dashboardWidgetContract.js";
import ReportAuditService from "../services/ReportAuditService.js";

// Reporting Platform Part 4 fix — DashboardWidgetContract projection.
// Only the fields actually present on a given dashboard's flat data
// become widgets (see utils/dashboardWidgetContract.js); this single map
// is safe to reuse across every Finance dashboardType since it only
// covers well-known metric/KPI keys shared across several of them.
const FINANCE_WIDGET_MAP = {
  cashToday: { title: "Cash Today", type: "metric" },
  bankBalance: { title: "Bank Balance", type: "metric" },
  outstandingAR: { title: "Outstanding Receivables", type: "metric" },
  outstandingAP: { title: "Outstanding Payables", type: "metric" },
  overdueReceivables: { title: "Overdue Receivables", type: "metric" },
  overduePayables: { title: "Overdue Payables", type: "metric" },
  todaysRevenue: { title: "Today's Revenue", type: "metric" },
  todaysExpenses: { title: "Today's Expenses", type: "metric" },
  netCashFlowToday: { title: "Net Cash Flow (Today)", type: "metric" },
  ebitda: { title: "EBITDA", type: "metric" },
  ebitdaMargin: { title: "EBITDA Margin", type: "metric" },
  expenseRatio: { title: "Expense Ratio", type: "metric" },
  operatingMargin: { title: "Operating Margin", type: "metric" },
  operatingRatio: { title: "Operating Ratio", type: "metric" },
  workingCapital: { title: "Working Capital", type: "metric" },
  currentRatio: { title: "Current Ratio", type: "metric" },
  quickRatio: { title: "Quick Ratio", type: "metric" },
  alertCount: { title: "Active Alerts", type: "metric" },
  fxExposureTotal: { title: "FX Exposure", type: "metric" },
};

// Dashboard access is governed entirely by RBAC permissions (admin-configurable
// via /api/v1/roles), never by hardcoded role names — mirrors
// VisaDashboardController.js's own discipline exactly.
const hasManagementAccess = (permissions) => permissions.includes("finance.dashboard.management") || permissions.includes("admin");

const dashboardScope = (req) => {
  const accessScope = getAccessScope(req);
  const permissions = req.auth?.permissions || [];
  return {
    tenantId: accessScope?.tenantId || null,
    userId: req.auth?.userId || req.auth?.id || null,
    period: req.query.period || "7 Days",
    metricKeys: req.query.metricKeys ? String(req.query.metricKeys).split(",").map((k) => k.trim()).filter(Boolean) : [],
    isManagement: hasManagementAccess(permissions),
    permissions,
  };
};

const statusFromError = (message = "") => {
  if (/not found/i.test(message)) return 404;
  if (/required|invalid/i.test(message)) return 400;
  return 500;
};

const handle = (method, message, { managementOnly = false, dashboardType = "unknown" } = {}) => async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = dashboardScope(req);
    if (!scope.tenantId) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!scope.permissions.includes("finance.dashboard.read") && !scope.permissions.includes("admin")) {
      return sendError(res, 403, "finance.dashboard.read permission required.", requestId);
    }
    if (managementOnly && !scope.isManagement) {
      return sendError(res, 403, "This dashboard requires the finance.dashboard.management permission.", requestId);
    }

    const result = await method.call(FinanceAnalyticsEngine, scope);

    // "Security... Audit Access" — same fire-and-forget, never-block-a-read
    // discipline as VisaDashboardController.js.
    if (mongoose.connection?.readyState === 1) {
      AuditLogModel.create({
        tenantId: scope.tenantId,
        userId: scope.userId || "system",
        action: "VIEW_DASHBOARD",
        module: "FinanceAnalytics",
        details: { dashboardType, isManagement: scope.isManagement, fromCache: result.fromCache },
      }).catch((err) => console.error("Finance dashboard audit log error:", err));
    }

    publishDashboardViewed(scope.tenantId, dashboardType, scope.userId);

    return sendSuccess(
      res,
      200,
      message,
      {
        ...result.data,
        // Reporting Platform Part 4 fix — additive DashboardWidgetContract
        // projection; every existing field above is unchanged.
        widgets: toWidgetArray(result.data, FINANCE_WIDGET_MAP),
        meta: { fromCache: result.fromCache, generatedAt: result.data?.generatedAt || null },
      },
      requestId
    );
  } catch (error) {
    return sendError(res, 500, error.message || "Dashboard unavailable.", requestId);
  }
};

// Reporting Platform Part 13 fix — the 5 endpoints below bypass the
// handle() factory above (they aren't per-dashboardType reads), so they
// never got its free audit-log call. Same fire-and-forget, readyState-guarded
// discipline as handle() itself; ReportAuditService is the additional
// tamper-evident layer alongside AuditLogModel.
const auditFinanceDashboardAction = (tenantId, userId, action, resourceKey, details = {}) => {
  if (mongoose.connection?.readyState === 1) {
    AuditLogModel.create({ tenantId, userId: userId || "system", action, module: "FinanceAnalytics", details })
      .catch((err) => console.error("Finance dashboard audit log error:", err));
  }
  ReportAuditService.recordEvent({
    tenantId, module: "Finance", resourceType: "Dashboard", resourceKey: resourceKey || "unknown",
    action: "VIEW", userId
  }).catch((err) => console.error("Finance dashboard report-audit error:", err));
};

// DashboardViewed is informational only.
const publishDashboardViewed = (tenantId, dashboardType, userId) => publishEvent("DashboardViewed", { tenantId, dashboardType, performedBy: userId || null, module: "Finance" });

export const getFinancialExecutiveDashboard = handle(
  FinanceAnalyticsEngine.executiveDashboard,
  "Executive financial dashboard retrieved successfully.",
  { managementOnly: true, dashboardType: "Executive" }
);

export const getFinancialCFODashboard = handle(
  FinanceAnalyticsEngine.cfoDashboard,
  "CFO financial dashboard retrieved successfully.",
  { managementOnly: true, dashboardType: "CFO" }
);

export const getFinancialTreasuryDashboard = handle(
  FinanceAnalyticsEngine.treasuryDashboard,
  "Treasury dashboard retrieved successfully.",
  { managementOnly: true, dashboardType: "Treasury" }
);

export const getFinancialARDashboard = handle(
  FinanceAnalyticsEngine.accountsReceivableDashboard,
  "Accounts Receivable dashboard retrieved successfully.",
  { dashboardType: "AccountsReceivable" }
);

export const getFinancialAPDashboard = handle(
  FinanceAnalyticsEngine.accountsPayableDashboard,
  "Accounts Payable dashboard retrieved successfully.",
  { dashboardType: "AccountsPayable" }
);

export const getFinancialRevenueDashboard = handle(
  FinanceAnalyticsEngine.revenueDashboard,
  "Revenue dashboard retrieved successfully.",
  { dashboardType: "Revenue" }
);

export const getFinancialExpenseDashboard = handle(
  FinanceAnalyticsEngine.expenseDashboard,
  "Expense dashboard retrieved successfully.",
  { dashboardType: "Expense" }
);

export const getFinancialCashFlowDashboard = handle(
  FinanceAnalyticsEngine.cashFlowDashboard,
  "Cash flow dashboard retrieved successfully.",
  { dashboardType: "CashFlow" }
);

export const getFinancialTaxDashboard = handle(
  FinanceAnalyticsEngine.taxDashboard,
  "Tax dashboard retrieved successfully.",
  { managementOnly: true, dashboardType: "Tax" }
);

// Financial Analytics Platform Enhancements — Part 29.
export const getFinancialCEODashboard = handle(
  FinanceAnalyticsEngine.ceoDashboard,
  "CEO financial dashboard retrieved successfully.",
  { managementOnly: true, dashboardType: "CEO" }
);

export const getFinancialBoardDashboard = handle(
  FinanceAnalyticsEngine.boardDashboard,
  "Board financial dashboard retrieved successfully.",
  { managementOnly: true, dashboardType: "Board" }
);

export const getFinancialDepartmentDashboard = handle(
  FinanceAnalyticsEngine.departmentDashboard,
  "Department financial dashboard retrieved successfully.",
  { dashboardType: "Department" }
);

// POST /api/v1/financial-dashboard/refresh — a manual "refresh now" trigger;
// KPIEngine.refreshFinanceSummary has always run automatically on domain
// events/cache-miss (Part 25), this fills the previously-missing synchronous
// on-demand path.
export const refreshFinancialDashboard = handle(
  FinanceAnalyticsEngine.refreshDashboard,
  "Financial dashboard refreshed successfully.",
  { managementOnly: true, dashboardType: "Refresh" }
);

export const getFinancialCustomDashboard = handle(
  FinanceAnalyticsEngine.customDashboard,
  "Custom financial dashboard retrieved successfully.",
  { dashboardType: "Custom" }
);

export const getFinancialDashboardKPIs = handle(
  FinanceAnalyticsEngine.calculateKPIs,
  "Financial dashboard KPIs retrieved successfully.",
  { dashboardType: "KPIs" }
);

export const getFinancialDashboardTrends = handle(
  FinanceAnalyticsEngine.generateTrends,
  "Financial dashboard trends retrieved successfully.",
  { dashboardType: "Trends" }
);

// ── Alerts ────────────────────────────────────────────────────

export const listDashboardAlerts = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const accessScope = getAccessScope(req);
    if (!accessScope) return sendError(res, 403, "Tenant context is required.", requestId);
    const permissions = req.auth?.permissions || [];
    if (!permissions.includes("finance.dashboard.read") && !permissions.includes("admin")) {
      return sendError(res, 403, "finance.dashboard.read permission required.", requestId);
    }
    const alerts = await FinanceAnalyticsEngine.listAlerts({ tenantId: accessScope.tenantId, status: req.query.status || null });
    auditFinanceDashboardAction(accessScope.tenantId, req.auth?.userId || req.auth?.id || null, "LIST_DASHBOARD_ALERTS", "alerts", { status: req.query.status || null });
    return sendSuccess(res, 200, "Dashboard alerts retrieved successfully.", { alerts }, requestId);
  } catch (error) {
    return sendError(res, statusFromError(error.message), error.message, requestId);
  }
};

export const acknowledgeDashboardAlert = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const accessScope = getAccessScope(req);
    if (!accessScope) return sendError(res, 403, "Tenant context is required.", requestId);
    const permissions = req.auth?.permissions || [];
    if (!permissions.includes("finance.dashboard.management") && !permissions.includes("admin")) {
      return sendError(res, 403, "finance.dashboard.management permission required.", requestId);
    }
    const userId = req.auth?.userId || req.auth?.id || null;
    const alert = await FinanceAnalyticsEngine.acknowledgeAlert({ tenantId: accessScope.tenantId, alertId: req.params.id, userId });
    auditFinanceDashboardAction(accessScope.tenantId, userId, "ACKNOWLEDGE_DASHBOARD_ALERT", req.params.id);
    return sendSuccess(res, 200, "Alert acknowledged successfully.", { alert }, requestId);
  } catch (error) {
    return sendError(res, statusFromError(error.message), error.message, requestId);
  }
};

// ── Drill-Through ─────────────────────────────────────────────

export const drillThroughDashboard = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const accessScope = getAccessScope(req);
    if (!accessScope) return sendError(res, 403, "Tenant context is required.", requestId);
    const permissions = req.auth?.permissions || [];
    if (!permissions.includes("finance.dashboard.read") && !permissions.includes("admin")) {
      return sendError(res, 403, "finance.dashboard.read permission required.", requestId);
    }
    if (!req.query.reportId || !req.query.accountId) throw new Error("reportId and accountId are required for drill-through.");
    const drillDown = await FinanceAnalyticsEngine.drillThrough({ tenantId: accessScope.tenantId, reportId: req.query.reportId, accountId: req.query.accountId });
    auditFinanceDashboardAction(accessScope.tenantId, req.auth?.userId || req.auth?.id || null, "DRILL_THROUGH_DASHBOARD", req.query.reportId, { accountId: req.query.accountId });
    return sendSuccess(res, 200, "Drill-through data retrieved successfully.", drillDown, requestId);
  } catch (error) {
    return sendError(res, statusFromError(error.message), error.message, requestId);
  }
};

// ── Personalization / Preferences ────────────────────────────

export const getDashboardPreferences = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const accessScope = getAccessScope(req);
    if (!accessScope) return sendError(res, 403, "Tenant context is required.", requestId);
    const userId = req.auth?.userId || req.auth?.id || null;
    if (!req.params.dashboardType) throw new Error("dashboardType is required.");
    const preferences = await FinanceAnalyticsEngine.getPreferences({ tenantId: accessScope.tenantId, userId, dashboardType: req.params.dashboardType });
    auditFinanceDashboardAction(accessScope.tenantId, userId, "GET_DASHBOARD_PREFERENCES", req.params.dashboardType);
    return sendSuccess(res, 200, "Dashboard preferences retrieved successfully.", { preferences }, requestId);
  } catch (error) {
    return sendError(res, statusFromError(error.message), error.message, requestId);
  }
};

export const saveDashboardPreferences = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const accessScope = getAccessScope(req);
    if (!accessScope) return sendError(res, 403, "Tenant context is required.", requestId);
    const userId = req.auth?.userId || req.auth?.id || null;
    const preferences = await FinanceAnalyticsEngine.savePreferences({ tenantId: accessScope.tenantId, userId, dashboardType: req.params.dashboardType, ...req.body });
    auditFinanceDashboardAction(accessScope.tenantId, userId, "SAVE_DASHBOARD_PREFERENCES", req.params.dashboardType);
    return sendSuccess(res, 200, "Dashboard preferences saved successfully.", { preferences }, requestId);
  } catch (error) {
    return sendError(res, statusFromError(error.message), error.message, requestId);
  }
};
