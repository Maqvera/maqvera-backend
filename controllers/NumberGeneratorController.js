import NumberGeneratorService from "../services/NumberGeneratorService.js";
import { sendSuccess, sendError } from "../utils/apiResponse.js";
import { createRequestId } from "../utils/authTokens.js";
import { getAccessScope } from "../utils/accessScope.js";

const hasPermission = (req, ...keys) => {
  const permissions = req.auth?.permissions || [];
  return permissions.includes("admin") || keys.some((key) => permissions.includes(key));
};

const statusFromError = (error) => {
  const message = error.message || "";
  if (message.includes("already") || message.includes("different resource")) return 409;
  if (message.includes("not found")) return 404;
  if (message.includes("required") || message.includes("Invalid") || message.includes("Cannot") || message.includes("No numbering scheme") || message.includes("allows gaps")) return 400;
  return 500;
};

const userIdOf = (req) => req.auth?.userId || req.auth?.id || null;

// Enterprise Identity & Global Resource ID Platform (Improvement 5). Same
// getAccessScope(req)-only tenant resolution + req.auth.permissions gating
// discipline as controllers/OrganisationController.js. Business logic
// (scheme resolution, atomic sequencing, Global Resource ID composition,
// events) lives entirely in services/NumberGeneratorService.js.

export const createScheme = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "numbering.manage")) return sendError(res, 403, "Permission denied.", requestId);

    const scheme = await NumberGeneratorService.createScheme(scope.tenantId, req.body, userIdOf(req));
    return sendSuccess(res, 201, "Numbering scheme created successfully.", scheme, requestId);
  } catch (error) {
    console.error("createScheme error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to create numbering scheme.", requestId);
  }
};

export const listSchemes = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "numbering.read")) return sendError(res, 403, "Permission denied.", requestId);

    const result = await NumberGeneratorService.listSchemes(scope.tenantId, req.query);
    return sendSuccess(res, 200, "Numbering schemes retrieved successfully.", result, requestId);
  } catch (error) {
    console.error("listSchemes error:", error);
    return sendError(res, 500, error.message || "Failed to retrieve numbering schemes.", requestId);
  }
};

export const getScheme = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "numbering.read")) return sendError(res, 403, "Permission denied.", requestId);

    const scheme = await NumberGeneratorService.getSchemeById(scope.tenantId, req.params.schemeId);
    return sendSuccess(res, 200, "Numbering scheme retrieved successfully.", scheme, requestId);
  } catch (error) {
    console.error("getScheme error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to retrieve numbering scheme.", requestId);
  }
};

export const updateScheme = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "numbering.manage")) return sendError(res, 403, "Permission denied.", requestId);

    const scheme = await NumberGeneratorService.updateScheme(scope.tenantId, req.params.schemeId, req.body, userIdOf(req));
    return sendSuccess(res, 200, "Numbering scheme updated successfully.", scheme, requestId);
  } catch (error) {
    console.error("updateScheme error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to update numbering scheme.", requestId);
  }
};

export const generateNumber = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "numbering.generate")) return sendError(res, 403, "Permission denied.", requestId);

    const generated = await NumberGeneratorService.generateNumber(scope.tenantId, req.body, userIdOf(req));
    return sendSuccess(res, 201, "Number generated successfully.", generated, requestId);
  } catch (error) {
    console.error("generateNumber error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to generate number.", requestId);
  }
};

export const registerResource = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "numbering.generate")) return sendError(res, 403, "Permission denied.", requestId);

    const generated = await NumberGeneratorService.registerResource(scope.tenantId, req.params.generatedNumberId, req.body.resourceUuid, userIdOf(req));
    return sendSuccess(res, 200, "Resource registered successfully.", generated, requestId);
  } catch (error) {
    console.error("registerResource error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to register resource.", requestId);
  }
};

export const rollbackSequence = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "numbering.generate")) return sendError(res, 403, "Permission denied.", requestId);

    const generated = await NumberGeneratorService.rollbackSequence(scope.tenantId, req.params.generatedNumberId, req.body?.reason, userIdOf(req));
    return sendSuccess(res, 200, "Sequence rolled back successfully.", generated, requestId);
  } catch (error) {
    console.error("rollbackSequence error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to roll back sequence.", requestId);
  }
};

export const resetSequence = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "numbering.manage")) return sendError(res, 403, "Permission denied.", requestId);

    const { key, newValue } = req.body;
    const result = await NumberGeneratorService.resetSequence(scope.tenantId, req.params.schemeId, key, newValue, userIdOf(req));
    return sendSuccess(res, 200, "Sequence reset successfully.", result, requestId);
  } catch (error) {
    console.error("resetSequence error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to reset sequence.", requestId);
  }
};

export const listHistory = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "numbering.read")) return sendError(res, 403, "Permission denied.", requestId);

    const result = await NumberGeneratorService.listHistory(scope.tenantId, req.query);
    return sendSuccess(res, 200, "Numbering history retrieved successfully.", result, requestId);
  } catch (error) {
    console.error("listHistory error:", error);
    return sendError(res, 500, error.message || "Failed to retrieve numbering history.", requestId);
  }
};
