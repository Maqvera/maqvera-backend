import PushPlatformService from "../services/PushPlatformService.js";
import { sendError, sendSuccess } from "../utils/apiResponse.js";
import { getAccessScope } from "../utils/accessScope.js";
import { createRequestId } from "../utils/authTokens.js";

/**
 * Enterprise Push Notification Platform Controller (Part 5).
 * Tenant-scoped only — no branchId per Master Architecture rules.
 */

const getScope = (req) => {
  const accessScope = getAccessScope(req);
  return {
    tenantId: accessScope?.tenantId || null,
    userId: req.auth?.userId || req.auth?.id || null
  };
};

const statusFromError = (err) => {
  const msg = err.message || "";
  if (/not found/i.test(msg)) return 404;
  if (/required|invalid|missing/i.test(msg)) return 400;
  return 500;
};

export const registerDevice = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const { tenantId, userId } = getScope(req);
    if (!tenantId || !userId) return sendError(res, 403, "Tenant/user context required.", requestId);

    const device = await PushPlatformService.registerDevice({ tenantId, userId, ...req.body });
    return sendSuccess(res, 201, "Device registered successfully.", device, requestId);
  } catch (err) {
    return sendError(res, statusFromError(err), err.message, requestId);
  }
};

export const unregisterDevice = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const { tenantId } = getScope(req);
    if (!tenantId) return sendError(res, 403, "Tenant context required.", requestId);

    const result = await PushPlatformService.unregisterDevice({ tenantId, token: req.params.token });
    return sendSuccess(res, 200, "Device unregistered.", result, requestId);
  } catch (err) {
    return sendError(res, statusFromError(err), err.message, requestId);
  }
};

export const listDevices = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const { tenantId, userId: currentUserId } = getScope(req);
    if (!tenantId) return sendError(res, 403, "Tenant context required.", requestId);

    const targetUserId = req.query.userId || currentUserId;
    const devices = await PushPlatformService.listDevices({ tenantId, userId: targetUserId });
    return sendSuccess(res, 200, "Devices retrieved.", devices, requestId);
  } catch (err) {
    return sendError(res, statusFromError(err), err.message, requestId);
  }
};

export const sendPushController = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const { tenantId } = getScope(req);
    if (!tenantId) return sendError(res, 403, "Tenant context required.", requestId);

    const results = await PushPlatformService.sendPush({ tenantId, ...req.body });
    return sendSuccess(res, 201, "Push notification processed for delivery.", results, requestId);
  } catch (err) {
    return sendError(res, statusFromError(err), err.message, requestId);
  }
};

export const getPushTrackingStatusController = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const { tenantId } = getScope(req);
    if (!tenantId) return sendError(res, 403, "Tenant context required.", requestId);

    const trackingStatus = await PushPlatformService.getPushTrackingStatus({ tenantId, trackingId: req.params.trackingId });
    return sendSuccess(res, 200, "Push delivery status retrieved.", trackingStatus, requestId);
  } catch (err) {
    return sendError(res, statusFromError(err), err.message, requestId);
  }
};
