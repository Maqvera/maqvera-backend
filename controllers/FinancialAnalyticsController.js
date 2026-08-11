import FinancialAnalyticsService from "../services/FinancialAnalyticsService.js";
import { sendSuccess, sendError } from "../utils/apiResponse.js";
import { createRequestId } from "../utils/authTokens.js";
import { getAccessScope } from "../utils/accessScope.js";

const hasPermission = (req, ...keys) => {
  const permissions = req.auth?.permissions || [];
  return permissions.includes("admin") || keys.some((key) => permissions.includes(key));
};

const statusFromError = (error) => {
  const message = error.message || "";
  if (message.includes("already")) return 409;
  if (message.includes("not found")) return 404;
  if (message.includes("required") || message.includes("cannot") || message.includes("Cannot") || message.includes("Invalid") || message.includes("not yet supported") || message.includes("Unrecognized") || message.includes("not supported") || message.includes("nothing real")) return 400;
  return 500;
};

export const runAnalysis = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.analytics.run")) return sendError(res, 403, "Permission denied.", requestId);
    const userId = req.auth?.userId || req.auth?.id || null;

    const analysis = await FinancialAnalyticsService.runAnalysis(req.body, scope.tenantId, userId);
    return sendSuccess(res, 201, "Financial analysis completed successfully.", analysis, requestId);
  } catch (error) {
    console.error("runAnalysis error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to run financial analysis.", requestId);
  }
};

export const listAnalytics = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.analytics.read")) return sendError(res, 403, "Permission denied.", requestId);

    const result = await FinancialAnalyticsService.listAnalytics(req.query, scope.tenantId);
    return sendSuccess(res, 200, "Financial analytics retrieved successfully.", result, requestId);
  } catch (error) {
    console.error("listAnalytics error:", error);
    return sendError(res, 500, error.message || "Failed to retrieve financial analytics.", requestId);
  }
};

export const getFinancialAnalysis = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.analytics.read")) return sendError(res, 403, "Permission denied.", requestId);

    const analysis = await FinancialAnalyticsService.getAnalyticsById(req.params.analysisId, scope.tenantId);
    return sendSuccess(res, 200, "Financial analysis retrieved successfully.", analysis, requestId);
  } catch (error) {
    console.error("getFinancialAnalysis error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to retrieve financial analysis.", requestId);
  }
};

export const cancelAnalysis = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.analytics.manage")) return sendError(res, 403, "Permission denied.", requestId);
    const userId = req.auth?.userId || req.auth?.id || null;

    const analysis = await FinancialAnalyticsService.cancelAnalysis(req.params.analysisId, scope.tenantId, userId);
    return sendSuccess(res, 200, "Financial analysis cancelled successfully.", analysis, requestId);
  } catch (error) {
    console.error("cancelAnalysis error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to cancel financial analysis.", requestId);
  }
};

export const archiveAnalysis = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.analytics.manage")) return sendError(res, 403, "Permission denied.", requestId);
    const userId = req.auth?.userId || req.auth?.id || null;

    const analysis = await FinancialAnalyticsService.archiveAnalysis(req.params.analysisId, scope.tenantId, userId);
    return sendSuccess(res, 200, "Financial analysis archived successfully.", analysis, requestId);
  } catch (error) {
    console.error("archiveAnalysis error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to archive financial analysis.", requestId);
  }
};
