import KPIDefinitionService from "../services/KPIDefinitionService.js";
import { sendError, sendSuccess } from "../utils/apiResponse.js";
import { getAccessScope } from "../utils/accessScope.js";
import { createRequestId } from "../utils/authTokens.js";

/**
 * Reporting Platform Part 5 fix — read/manage the KPI definition registry
 * (KPIDefinitionModel). Same layering/response-envelope convention as
 * ReportTemplateController.js. Read (list/get) requires "reporting.read";
 * register/deprecate require "reporting.kpis.manage" — enforced in
 * routes/KPIDefinitionRoutes.js.
 */

const getScope = (req) => {
  const accessScope = getAccessScope(req);
  return {
    tenantId: accessScope?.tenantId || null,
    userId: req.auth?.userId || req.auth?.id || null,
    permissions: req.auth?.permissions || []
  };
};

const canRead = (permissions) => permissions.includes("reporting.read") || permissions.includes("admin");
const canManage = (permissions) => permissions.includes("reporting.kpis.manage") || permissions.includes("admin");

const statusFromError = (err) => {
  const msg = err.message || "";
  if (/not found/i.test(msg)) return 404;
  if (/already exists|required|invalid|missing/i.test(msg)) return 400;
  return 500;
};

export const registerKPIDefinition = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const { tenantId, userId, permissions } = getScope(req);
    if (!tenantId) return sendError(res, 403, "Tenant context required.", requestId);
    if (!canManage(permissions)) return sendError(res, 403, "Permission denied.", requestId);

    const definition = await KPIDefinitionService.registerDefinition({ tenantId, ...req.body, userId });
    return sendSuccess(res, 201, "KPI definition registered successfully.", definition, requestId);
  } catch (err) {
    return sendError(res, statusFromError(err), err.message, requestId);
  }
};

export const listKPIDefinitions = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const { tenantId, permissions } = getScope(req);
    if (!tenantId) return sendError(res, 403, "Tenant context required.", requestId);
    if (!canRead(permissions)) return sendError(res, 403, "Permission denied.", requestId);

    const { ownerModule, status, page, limit } = req.query;
    const result = await KPIDefinitionService.listDefinitions({ tenantId, ownerModule, status, page, limit });
    return sendSuccess(res, 200, "KPI definitions retrieved successfully.", result, requestId);
  } catch (err) {
    return sendError(res, statusFromError(err), err.message, requestId);
  }
};

export const getKPIDefinition = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const { tenantId, permissions } = getScope(req);
    if (!tenantId) return sendError(res, 403, "Tenant context required.", requestId);
    if (!canRead(permissions)) return sendError(res, 403, "Permission denied.", requestId);

    const definition = await KPIDefinitionService.getDefinition({ tenantId, kpiKey: req.params.kpiKey, ownerModule: req.query.ownerModule });
    return sendSuccess(res, 200, "KPI definition retrieved successfully.", definition, requestId);
  } catch (err) {
    return sendError(res, statusFromError(err), err.message, requestId);
  }
};

export const deprecateKPIDefinition = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const { tenantId, userId, permissions } = getScope(req);
    if (!tenantId) return sendError(res, 403, "Tenant context required.", requestId);
    if (!canManage(permissions)) return sendError(res, 403, "Permission denied.", requestId);

    const definition = await KPIDefinitionService.deprecateDefinition({ tenantId, kpiKey: req.params.kpiKey, ownerModule: req.body.ownerModule, userId });
    return sendSuccess(res, 200, "KPI definition deprecated successfully.", definition, requestId);
  } catch (err) {
    return sendError(res, statusFromError(err), err.message, requestId);
  }
};
