import ReportCatalogService from "../services/ReportCatalogService.js";
import { sendError, sendSuccess } from "../utils/apiResponse.js";
import { getAccessScope } from "../utils/accessScope.js";
import { createRequestId } from "../utils/authTokens.js";

/**
 * Reporting Platform Part 2 fix — read/manage the report catalog registry
 * (ReportCatalogModel). Same layering/response-envelope convention as
 * ReportTemplateController.js/KPIDefinitionController.js. Read (list/get)
 * requires "reporting.read"; register/transition require
 * "reporting.catalog.manage" — enforced in routes/ReportCatalogRoutes.js.
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
const canManage = (permissions) => permissions.includes("reporting.catalog.manage") || permissions.includes("admin");

const statusFromError = (err) => {
  const msg = err.message || "";
  if (/not found/i.test(msg)) return 404;
  if (/already exists|required|invalid|missing/i.test(msg)) return 400;
  return 500;
};

export const registerReportCatalogEntry = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const { tenantId, userId, permissions } = getScope(req);
    if (!tenantId) return sendError(res, 403, "Tenant context required.", requestId);
    if (!canManage(permissions)) return sendError(res, 403, "Permission denied.", requestId);

    const entry = await ReportCatalogService.registerCatalogEntry({ tenantId, ...req.body, userId });
    return sendSuccess(res, 201, "Report catalog entry registered successfully.", entry, requestId);
  } catch (err) {
    return sendError(res, statusFromError(err), err.message, requestId);
  }
};

export const listReportCatalogEntries = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const { tenantId, permissions } = getScope(req);
    if (!tenantId) return sendError(res, 403, "Tenant context required.", requestId);
    if (!canRead(permissions)) return sendError(res, 403, "Permission denied.", requestId);

    const { module, lifecycleState, tag, page, limit } = req.query;
    const result = await ReportCatalogService.listCatalogEntries({ tenantId, module, lifecycleState, tag, page, limit });
    return sendSuccess(res, 200, "Report catalog entries retrieved successfully.", result, requestId);
  } catch (err) {
    return sendError(res, statusFromError(err), err.message, requestId);
  }
};

export const getReportCatalogEntry = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const { tenantId, permissions } = getScope(req);
    if (!tenantId) return sendError(res, 403, "Tenant context required.", requestId);
    if (!canRead(permissions)) return sendError(res, 403, "Permission denied.", requestId);

    const entry = await ReportCatalogService.getCatalogEntry({ tenantId, reportKey: req.params.reportKey });
    return sendSuccess(res, 200, "Report catalog entry retrieved successfully.", entry, requestId);
  } catch (err) {
    return sendError(res, statusFromError(err), err.message, requestId);
  }
};

export const transitionReportCatalogLifecycle = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const { tenantId, userId, permissions } = getScope(req);
    if (!tenantId) return sendError(res, 403, "Tenant context required.", requestId);
    if (!canManage(permissions)) return sendError(res, 403, "Permission denied.", requestId);

    const { lifecycleState, adminOverride } = req.body;
    const entry = await ReportCatalogService.transitionLifecycle({ tenantId, reportKey: req.params.reportKey, lifecycleState, adminOverride, userId });
    return sendSuccess(res, 200, "Report catalog lifecycle state updated successfully.", entry, requestId);
  } catch (err) {
    return sendError(res, statusFromError(err), err.message, requestId);
  }
};
