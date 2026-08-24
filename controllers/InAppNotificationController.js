import InAppNotificationService from "../services/InAppNotificationService.js";
import { sendError, sendSuccess } from "../utils/apiResponse.js";
import { getAccessScope } from "../utils/accessScope.js";
import { createRequestId } from "../utils/authTokens.js";

/**
 * Enterprise In-App Notification Platform Controller (Part 6).
 * Always the caller's OWN notification inbox — no separate permission key
 * beyond authentication is needed, same lighter-touch pattern as
 * CommunicationPlatformController's preference endpoints.
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

export const listNotifications = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const { tenantId, userId } = getScope(req);
    if (!tenantId || !userId) return sendError(res, 403, "Tenant/user context required.", requestId);

    const { status, page, limit } = req.query;
    const result = await InAppNotificationService.listNotifications({ tenantId, userId, status, page, limit });

    return sendSuccess(res, 200, "Notifications retrieved successfully.", result, requestId);
  } catch (err) {
    return sendError(res, statusFromError(err), err.message, requestId);
  }
};

export const getUnreadCount = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const { tenantId, userId } = getScope(req);
    if (!tenantId || !userId) return sendError(res, 403, "Tenant/user context required.", requestId);

    const unreadCount = await InAppNotificationService.getUnreadCount({ tenantId, userId });
    return sendSuccess(res, 200, "Unread notification count retrieved.", { unreadCount }, requestId);
  } catch (err) {
    return sendError(res, statusFromError(err), err.message, requestId);
  }
};

export const markNotificationRead = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const { tenantId, userId } = getScope(req);
    if (!tenantId || !userId) return sendError(res, 403, "Tenant/user context required.", requestId);

    const notification = await InAppNotificationService.markAsRead({ tenantId, userId, notificationId: req.params.notificationId });
    return sendSuccess(res, 200, "Notification marked as read.", notification, requestId);
  } catch (err) {
    return sendError(res, statusFromError(err), err.message, requestId);
  }
};

export const markAllNotificationsRead = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const { tenantId, userId } = getScope(req);
    if (!tenantId || !userId) return sendError(res, 403, "Tenant/user context required.", requestId);

    const result = await InAppNotificationService.markAllAsRead({ tenantId, userId });
    return sendSuccess(res, 200, "All notifications marked as read.", result, requestId);
  } catch (err) {
    return sendError(res, statusFromError(err), err.message, requestId);
  }
};

export const archiveNotification = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const { tenantId, userId } = getScope(req);
    if (!tenantId || !userId) return sendError(res, 403, "Tenant/user context required.", requestId);

    const notification = await InAppNotificationService.archiveNotification({ tenantId, userId, notificationId: req.params.notificationId });
    return sendSuccess(res, 200, "Notification archived.", notification, requestId);
  } catch (err) {
    return sendError(res, statusFromError(err), err.message, requestId);
  }
};
