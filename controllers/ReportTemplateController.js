import ReportTemplateService from "../services/ReportTemplateService.js";
import { sendError, sendSuccess } from "../utils/apiResponse.js";
import { getAccessScope } from "../utils/accessScope.js";
import { createRequestId } from "../utils/authTokens.js";

/**
 * Reporting Platform Part 8 fix — admin CRUD for the report template
 * registry (ReportTemplateModel), same layering/response-envelope
 * convention as CommunicationPlatformController.js's template endpoints.
 * Read (list/get) requires "reporting.read"; create/update/publish/archive
 * require "reporting.templates.manage" — enforced in routes/ReportTemplateRoutes.js.
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
const canManage = (permissions) => permissions.includes("reporting.templates.manage") || permissions.includes("admin");

const statusFromError = (err) => {
  const msg = err.message || "";
  if (/not found/i.test(msg)) return 404;
  if (/already exists|required|invalid|missing/i.test(msg)) return 400;
  return 500;
};

export const createReportTemplate = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const { tenantId, userId, permissions } = getScope(req);
    if (!tenantId) return sendError(res, 403, "Tenant context required.", requestId);
    if (!canManage(permissions)) return sendError(res, 403, "Permission denied.", requestId);

    const template = await ReportTemplateService.createTemplate({ tenantId, ...req.body, userId });
    return sendSuccess(res, 201, "Report template created successfully.", template, requestId);
  } catch (err) {
    return sendError(res, statusFromError(err), err.message, requestId);
  }
};

export const listReportTemplates = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const { tenantId, permissions } = getScope(req);
    if (!tenantId) return sendError(res, 403, "Tenant context required.", requestId);
    if (!canRead(permissions)) return sendError(res, 403, "Permission denied.", requestId);

    const { reportType, status, page, limit } = req.query;
    const result = await ReportTemplateService.listTemplates({ tenantId, reportType, status, page, limit });
    return sendSuccess(res, 200, "Report templates retrieved successfully.", result, requestId);
  } catch (err) {
    return sendError(res, statusFromError(err), err.message, requestId);
  }
};

export const getReportTemplate = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const { tenantId, permissions } = getScope(req);
    if (!tenantId) return sendError(res, 403, "Tenant context required.", requestId);
    if (!canRead(permissions)) return sendError(res, 403, "Permission denied.", requestId);

    const template = await ReportTemplateService.getTemplate({ tenantId, templateKey: req.params.templateKey, locale: req.query.locale || "en" });
    return sendSuccess(res, 200, "Report template retrieved successfully.", template, requestId);
  } catch (err) {
    return sendError(res, statusFromError(err), err.message, requestId);
  }
};

export const updateReportTemplate = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const { tenantId, userId, permissions } = getScope(req);
    if (!tenantId) return sendError(res, 403, "Tenant context required.", requestId);
    if (!canManage(permissions)) return sendError(res, 403, "Permission denied.", requestId);

    const { locale, htmlBody, brandingConfig } = req.body;
    const template = await ReportTemplateService.updateTemplate({ tenantId, templateKey: req.params.templateKey, locale, htmlBody, brandingConfig, userId });
    return sendSuccess(res, 200, "Report template updated successfully.", template, requestId);
  } catch (err) {
    return sendError(res, statusFromError(err), err.message, requestId);
  }
};

export const publishReportTemplate = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const { tenantId, userId, permissions } = getScope(req);
    if (!tenantId) return sendError(res, 403, "Tenant context required.", requestId);
    if (!canManage(permissions)) return sendError(res, 403, "Permission denied.", requestId);

    const template = await ReportTemplateService.setStatus({ tenantId, templateKey: req.params.templateKey, locale: req.body.locale, status: "Active", userId });
    return sendSuccess(res, 200, "Report template published successfully.", template, requestId);
  } catch (err) {
    return sendError(res, statusFromError(err), err.message, requestId);
  }
};

export const archiveReportTemplate = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const { tenantId, userId, permissions } = getScope(req);
    if (!tenantId) return sendError(res, 403, "Tenant context required.", requestId);
    if (!canManage(permissions)) return sendError(res, 403, "Permission denied.", requestId);

    const template = await ReportTemplateService.setStatus({ tenantId, templateKey: req.params.templateKey, locale: req.body.locale, status: "Archived", userId });
    return sendSuccess(res, 200, "Report template archived successfully.", template, requestId);
  } catch (err) {
    return sendError(res, statusFromError(err), err.message, requestId);
  }
};
