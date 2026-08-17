import FinancePlatformOrchestrationService from "../services/FinancePlatformOrchestrationService.js";
import { sendError, sendSuccess } from "../utils/apiResponse.js";
import { getAccessScope } from "../utils/accessScope.js";
import { createRequestId } from "../utils/authTokens.js";

/**
 * Enterprise Finance Platform Master Orchestration Controller — Part 20.
 * Handles end-to-end financial request processing across Governance, Treasury, Analytics, Audit,
 * platform architecture blueprint retrieval, and multi-sub-platform health status monitoring.
 * Tenant-scoped only — no branchId per Master Architecture rules.
 */

const getScope = (req) => {
  const accessScope = getAccessScope(req);
  return {
    tenantId: accessScope?.tenantId || null,
    userId: req.auth?.userId || req.auth?.id || null
  };
};

const hasPermission = (req, ...keys) => {
  const permissions = req.auth?.permissions || [];
  return permissions.includes("admin") || keys.some((key) => permissions.includes(key));
};

const statusFromError = (err) => {
  const msg = err.message || "";
  if (/not found/i.test(msg)) return 404;
  if (/required|invalid|missing/i.test(msg)) return 400;
  return 500;
};

// 1. Process Financial Request Pipeline
export const processFinancialRequest = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const { tenantId, userId } = getScope(req);
    if (!tenantId) return sendError(res, 403, "Tenant context required.", requestId);
    if (!hasPermission(req, "finance.platform.orchestrate")) return sendError(res, 403, "Permission denied.", requestId);

    const result = await FinancePlatformOrchestrationService.processFinancialRequest({
      tenantId,
      ...req.body,
      userId
    });

    const statusCode = result.status === "SUCCESS" ? 200 : result.status === "REJECTED" ? 422 : 202;
    return sendSuccess(res, statusCode, `Financial request processed with status: ${result.status}`, result, requestId);
  } catch (err) {
    return sendError(res, statusFromError(err), err.message, requestId);
  }
};

// 2. Master Architecture Blueprint
export const getPlatformArchitecture = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const { tenantId } = getScope(req);
    if (!tenantId) return sendError(res, 403, "Tenant context required.", requestId);
    if (!hasPermission(req, "finance.platform.read", "finance.platform.orchestrate")) return sendError(res, 403, "Permission denied.", requestId);

    const blueprint = FinancePlatformOrchestrationService.getPlatformArchitectureBlueprint({ tenantId });
    return sendSuccess(res, 200, "Enterprise Finance Platform architecture blueprint retrieved.", blueprint, requestId);
  } catch (err) {
    return sendError(res, statusFromError(err), err.message, requestId);
  }
};

// 3. Platform Health & Operational Status
export const getPlatformHealthStatus = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const { tenantId } = getScope(req);
    if (!tenantId) return sendError(res, 403, "Tenant context required.", requestId);
    if (!hasPermission(req, "finance.platform.read", "finance.platform.orchestrate")) return sendError(res, 403, "Permission denied.", requestId);

    const health = await FinancePlatformOrchestrationService.getPlatformHealthStatus({ tenantId });
    return sendSuccess(res, 200, "Enterprise Finance Platform health status retrieved.", health, requestId);
  } catch (err) {
    return sendError(res, statusFromError(err), err.message, requestId);
  }
};
