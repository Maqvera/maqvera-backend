import { registerEvent, listEventRegistry, getEventRegistryEntry, deprecateEventVersion, retireEventVersion, reactivateEventVersion } from "../utils/eventVersioning.js";
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

// Enterprise Event Versioning Standard (Enterprise Architecture Hardening
// Phase, Improvement 7). The Event Registry is platform-level metadata
// (which event names/versions exist, who owns them, their lifecycle
// status) — not tenant-owned business data — so reads/writes here are
// not filtered by tenant, same "no separate Platform Operator identity"
// reasoning already used for Improvement 3's Merchant platform and
// Improvement 6's Circuit Breaker status: any authenticated tenant's
// admin can see/manage it, gated by real permission keys rather than a
// second identity system this codebase doesn't have.

export const createEventRegistration = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "eventregistry.manage")) return sendError(res, 403, "Permission denied.", requestId);

    const { eventName, version, category, owner, description } = req.body;
    const entry = await registerEvent(eventName, version, { category, owner, description, userId: userIdOf(req) });
    return sendSuccess(res, 201, "Event registered successfully.", entry, requestId);
  } catch (error) {
    console.error("createEventRegistration error:", error);
    return sendError(res, error.httpStatus || statusFromError(error), error.message || "Failed to register event.", requestId, error.details ? { code: error.code, details: error.details } : undefined);
  }
};

export const listEventRegistrations = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "eventregistry.read")) return sendError(res, 403, "Permission denied.", requestId);

    const result = await listEventRegistry(req.query);
    return sendSuccess(res, 200, "Event registry retrieved successfully.", result, requestId);
  } catch (error) {
    console.error("listEventRegistrations error:", error);
    return sendError(res, 500, error.message || "Failed to retrieve event registry.", requestId);
  }
};

export const getEventRegistration = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "eventregistry.read")) return sendError(res, 403, "Permission denied.", requestId);

    const entry = await getEventRegistryEntry(req.params.eventName, req.params.version);
    return sendSuccess(res, 200, "Event registry entry retrieved successfully.", entry, requestId);
  } catch (error) {
    console.error("getEventRegistration error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to retrieve event registry entry.", requestId);
  }
};

export const deprecateEventRegistration = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "eventregistry.manage")) return sendError(res, 403, "Permission denied.", requestId);

    const entry = await deprecateEventVersion(req.params.eventName, req.params.version, req.body?.reason, userIdOf(req));
    return sendSuccess(res, 200, "Event version deprecated successfully.", entry, requestId);
  } catch (error) {
    console.error("deprecateEventRegistration error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to deprecate event version.", requestId);
  }
};

export const retireEventRegistration = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "eventregistry.manage")) return sendError(res, 403, "Permission denied.", requestId);

    const entry = await retireEventVersion(req.params.eventName, req.params.version, userIdOf(req));
    return sendSuccess(res, 200, "Event version retired successfully.", entry, requestId);
  } catch (error) {
    console.error("retireEventRegistration error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to retire event version.", requestId);
  }
};

export const reactivateEventRegistration = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "eventregistry.manage")) return sendError(res, 403, "Permission denied.", requestId);

    const entry = await reactivateEventVersion(req.params.eventName, req.params.version, userIdOf(req));
    return sendSuccess(res, 200, "Event version reactivated successfully.", entry, requestId);
  } catch (error) {
    console.error("reactivateEventRegistration error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to reactivate event version.", requestId);
  }
};
