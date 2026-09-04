import LeadService from "../services/LeadService.js";
import { sendSuccess, sendError } from "../utils/apiResponse.js";
import { createRequestId } from "../utils/authTokens.js";
import { getAccessScope } from "../utils/accessScope.js";

const hasPermission = (req, ...keys) => {
  const permissions = req.auth?.permissions || [];
  return permissions.includes("admin") || keys.some((key) => permissions.includes(key));
};

const statusFromError = (error) => {
  const message = error.message || "";
  if (message.includes("already exists") || message.includes("already been converted")) return 409;
  if (message.includes("not found")) return 404;
  if (message.includes("required") || message.includes("Invalid")) return 400;
  return 500;
};

const userIdFrom = (req) => req.auth?.userId || req.auth?.id || null;

export const createLead = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "lead.create", "lead.manage")) return sendError(res, 403, "Permission denied.", requestId);

    const lead = await LeadService.createLead(req.body, scope.tenantId, userIdFrom(req));
    return sendSuccess(res, 201, "Lead created successfully.", lead, requestId);
  } catch (error) {
    console.error("createLead error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to create lead.", requestId);
  }
};

export const listLeads = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "lead.read", "lead.manage")) return sendError(res, 403, "Permission denied.", requestId);

    const result = await LeadService.listLeads(req.query, scope.tenantId);
    return sendSuccess(res, 200, "Leads retrieved successfully.", result, requestId);
  } catch (error) {
    console.error("listLeads error:", error);
    return sendError(res, 500, error.message || "Failed to retrieve leads.", requestId);
  }
};

export const getPipeline = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "lead.read", "lead.manage")) return sendError(res, 403, "Permission denied.", requestId);

    const pipeline = await LeadService.getPipeline(scope.tenantId);
    return sendSuccess(res, 200, "Lead pipeline retrieved successfully.", { pipeline }, requestId);
  } catch (error) {
    console.error("getPipeline error:", error);
    return sendError(res, 500, error.message || "Failed to retrieve lead pipeline.", requestId);
  }
};

export const getLead = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "lead.read", "lead.manage")) return sendError(res, 403, "Permission denied.", requestId);

    const lead = await LeadService.getLeadById(req.params.leadId, scope.tenantId);
    return sendSuccess(res, 200, "Lead retrieved successfully.", lead, requestId);
  } catch (error) {
    console.error("getLead error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to retrieve lead.", requestId);
  }
};

export const updateLead = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "lead.manage")) return sendError(res, 403, "Permission denied.", requestId);

    const lead = await LeadService.updateLead(req.params.leadId, req.body, scope.tenantId, userIdFrom(req));
    return sendSuccess(res, 200, "Lead updated successfully.", lead, requestId);
  } catch (error) {
    console.error("updateLead error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to update lead.", requestId);
  }
};

export const convertLead = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "lead.manage")) return sendError(res, 403, "Permission denied.", requestId);

    const lead = await LeadService.convertToCustomer(req.params.leadId, req.body || {}, scope.tenantId, userIdFrom(req), requestId);
    return sendSuccess(res, 200, "Lead converted to customer successfully.", lead, requestId);
  } catch (error) {
    console.error("convertLead error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to convert lead.", requestId);
  }
};
