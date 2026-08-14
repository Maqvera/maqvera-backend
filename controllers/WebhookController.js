import WebhookService from "../services/WebhookService.js";
import { sendSuccess, sendError } from "../utils/apiResponse.js";
import { createRequestId } from "../utils/authTokens.js";
import { getAccessScope } from "../utils/accessScope.js";

const hasPermission = (req, ...keys) => {
  const permissions = req.auth?.permissions || [];
  return permissions.includes("admin") || keys.some((key) => permissions.includes(key));
};

const statusFromError = (error) => {
  const message = error.message || "";
  if (message.includes("not found")) return 404;
  if (message.includes("required") || message.includes("Invalid") || message.includes("valid absolute URL") || message.includes("Cannot")) return 400;
  return 500;
};

export const createWebhookSubscription = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.webhook.manage")) return sendError(res, 403, "Permission denied.", requestId);
    const userId = req.auth?.userId || req.auth?.id || null;

    const subscription = await WebhookService.createSubscription(req.body, scope.tenantId, userId);
    return sendSuccess(res, 201, "Webhook subscription created successfully. Store the secret now — it will not be shown again.", subscription, requestId);
  } catch (error) {
    console.error("createWebhookSubscription error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to create webhook subscription.", requestId);
  }
};

export const listWebhookSubscriptions = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.webhook.read", "finance.read")) return sendError(res, 403, "Permission denied.", requestId);

    const items = await WebhookService.listSubscriptions(req.query, scope.tenantId);
    return sendSuccess(res, 200, "Webhook subscriptions retrieved successfully.", { items }, requestId);
  } catch (error) {
    console.error("listWebhookSubscriptions error:", error);
    return sendError(res, 500, error.message || "Failed to retrieve webhook subscriptions.", requestId);
  }
};

export const getWebhookSubscription = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.webhook.read", "finance.read")) return sendError(res, 403, "Permission denied.", requestId);

    const subscription = await WebhookService.getSubscriptionById(req.params.subscriptionId, scope.tenantId);
    return sendSuccess(res, 200, "Webhook subscription retrieved successfully.", subscription, requestId);
  } catch (error) {
    console.error("getWebhookSubscription error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to retrieve webhook subscription.", requestId);
  }
};

export const rotateWebhookSecret = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.webhook.manage")) return sendError(res, 403, "Permission denied.", requestId);
    const userId = req.auth?.userId || req.auth?.id || null;

    const subscription = await WebhookService.rotateSecret(req.params.subscriptionId, scope.tenantId, userId);
    return sendSuccess(res, 200, "Webhook secret rotated successfully. Store the new secret now — it will not be shown again.", subscription, requestId);
  } catch (error) {
    console.error("rotateWebhookSecret error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to rotate webhook secret.", requestId);
  }
};

export const suspendWebhookSubscription = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.webhook.manage")) return sendError(res, 403, "Permission denied.", requestId);
    const userId = req.auth?.userId || req.auth?.id || null;

    const subscription = await WebhookService.updateStatus(req.params.subscriptionId, "Suspended", req.body, scope.tenantId, userId);
    return sendSuccess(res, 200, "Webhook subscription suspended successfully.", subscription, requestId);
  } catch (error) {
    console.error("suspendWebhookSubscription error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to suspend webhook subscription.", requestId);
  }
};

export const reactivateWebhookSubscription = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.webhook.manage")) return sendError(res, 403, "Permission denied.", requestId);
    const userId = req.auth?.userId || req.auth?.id || null;

    const subscription = await WebhookService.updateStatus(req.params.subscriptionId, "Active", req.body, scope.tenantId, userId);
    return sendSuccess(res, 200, "Webhook subscription reactivated successfully.", subscription, requestId);
  } catch (error) {
    console.error("reactivateWebhookSubscription error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to reactivate webhook subscription.", requestId);
  }
};

export const disableWebhookSubscription = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.webhook.manage")) return sendError(res, 403, "Permission denied.", requestId);
    const userId = req.auth?.userId || req.auth?.id || null;

    const subscription = await WebhookService.updateStatus(req.params.subscriptionId, "Disabled", req.body, scope.tenantId, userId);
    return sendSuccess(res, 200, "Webhook subscription disabled successfully.", subscription, requestId);
  } catch (error) {
    console.error("disableWebhookSubscription error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to disable webhook subscription.", requestId);
  }
};

export const listWebhookDeliveries = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.webhook.read", "finance.read")) return sendError(res, 403, "Permission denied.", requestId);

    const items = await WebhookService.listDeliveries(req.params.subscriptionId, scope.tenantId, req.query);
    return sendSuccess(res, 200, "Webhook deliveries retrieved successfully.", { items }, requestId);
  } catch (error) {
    console.error("listWebhookDeliveries error:", error);
    return sendError(res, 500, error.message || "Failed to retrieve webhook deliveries.", requestId);
  }
};

export const replayWebhookDelivery = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.webhook.manage")) return sendError(res, 403, "Permission denied.", requestId);

    const delivery = await WebhookService.replayDelivery(req.params.deliveryId, scope.tenantId);
    return sendSuccess(res, 200, "Webhook delivery replayed.", delivery, requestId);
  } catch (error) {
    console.error("replayWebhookDelivery error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to replay webhook delivery.", requestId);
  }
};
