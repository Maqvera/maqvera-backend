import { registerApiVersion, deprecateApiVersion, sunsetApiVersion, retireApiVersion, listApiVersions, getApiVersionEntry } from "../utils/apiVersioning.js";
import { sendSuccess, sendError } from "../utils/apiResponse.js";
import { createRequestId } from "../utils/authTokens.js";
import { getAccessScope } from "../utils/accessScope.js";

const hasPermission = (req, ...keys) => {
  const permissions = req.auth?.permissions || [];
  return permissions.includes("admin") || keys.some((key) => permissions.includes(key));
};

const statusFromError = (error) => {
  const message = error.message || "";
  if (message.includes("already registered") || message.includes("Cannot")) return 409;
  if (message.includes("not found")) return 404;
  if (message.includes("required") || message.includes("Invalid")) return 400;
  return 500;
};

const userIdOf = (req) => req.auth?.userId || req.auth?.id || null;

// Enterprise API Version Strategy Standard (Enterprise Architecture
// Hardening Phase, Improvement 8). Platform-level metadata (which API
// versions exist, their lifecycle, support windows) — not tenant-owned
// business data, same reasoning as Improvement 7's Event Registry.

export const createApiVersionRegistration = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "apiversion.manage")) return sendError(res, 403, "Permission denied.", requestId);

    const { apiName, version, status, owner, description, supportedUntil } = req.body;
    const entry = await registerApiVersion(apiName, version, { status, owner, description, supportedUntil, userId: userIdOf(req) });
    return sendSuccess(res, 201, "API version registered successfully.", entry, requestId);
  } catch (error) {
    console.error("createApiVersionRegistration error:", error);
    return sendError(res, error.httpStatus || statusFromError(error), error.message || "Failed to register API version.", requestId, error.details ? { code: error.code, details: error.details } : undefined);
  }
};

export const listApiVersionRegistrations = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "apiversion.read")) return sendError(res, 403, "Permission denied.", requestId);

    const result = await listApiVersions(req.query);
    return sendSuccess(res, 200, "API version registry retrieved successfully.", result, requestId);
  } catch (error) {
    console.error("listApiVersionRegistrations error:", error);
    return sendError(res, 500, error.message || "Failed to retrieve API version registry.", requestId);
  }
};

export const getApiVersionRegistration = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "apiversion.read")) return sendError(res, 403, "Permission denied.", requestId);

    const entry = await getApiVersionEntry(req.params.apiName, req.params.version);
    return sendSuccess(res, 200, "API version entry retrieved successfully.", entry, requestId);
  } catch (error) {
    console.error("getApiVersionRegistration error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to retrieve API version entry.", requestId);
  }
};

export const deprecateApiVersionRegistration = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "apiversion.manage")) return sendError(res, 403, "Permission denied.", requestId);

    const { sunsetAt, latestVersion, reason } = req.body || {};
    const entry = await deprecateApiVersion(req.params.apiName, req.params.version, { sunsetAt, latestVersion, reason, userId: userIdOf(req) });
    return sendSuccess(res, 200, "API version deprecated successfully.", entry, requestId);
  } catch (error) {
    console.error("deprecateApiVersionRegistration error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to deprecate API version.", requestId);
  }
};

export const sunsetApiVersionRegistration = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "apiversion.manage")) return sendError(res, 403, "Permission denied.", requestId);

    const entry = await sunsetApiVersion(req.params.apiName, req.params.version, userIdOf(req));
    return sendSuccess(res, 200, "API version sunset successfully.", entry, requestId);
  } catch (error) {
    console.error("sunsetApiVersionRegistration error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to sunset API version.", requestId);
  }
};

export const retireApiVersionRegistration = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "apiversion.manage")) return sendError(res, 403, "Permission denied.", requestId);

    const entry = await retireApiVersion(req.params.apiName, req.params.version, userIdOf(req));
    return sendSuccess(res, 200, "API version retired successfully.", entry, requestId);
  } catch (error) {
    console.error("retireApiVersionRegistration error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to retire API version.", requestId);
  }
};
