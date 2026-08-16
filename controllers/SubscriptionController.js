import SubscriptionService from "../services/SubscriptionService.js";
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
  if (message.includes("required") || message.includes("Invalid") || message.includes("cannot") || message.includes("Cannot") || message.includes("only applies") || message.includes("not a real") || message.includes("already")) return 400;
  return 500;
};

export const createSubscription = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.subscription.create")) return sendError(res, 403, "Permission denied.", requestId);
    const userId = req.auth?.userId || req.auth?.id || null;

    const subscription = await SubscriptionService.createSubscription(req.body, scope.tenantId, userId);
    return sendSuccess(res, 201, "Subscription created successfully.", subscription, requestId);
  } catch (error) {
    console.error("createSubscription error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to create subscription.", requestId);
  }
};

export const listSubscriptions = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.subscription.read", "finance.read")) return sendError(res, 403, "Permission denied.", requestId);

    const result = await SubscriptionService.listSubscriptions(req.query, scope.tenantId);
    return sendSuccess(res, 200, "Subscriptions retrieved successfully.", result, requestId);
  } catch (error) {
    console.error("listSubscriptions error:", error);
    return sendError(res, 500, error.message || "Failed to retrieve subscriptions.", requestId);
  }
};

export const getSubscription = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.subscription.read", "finance.read")) return sendError(res, 403, "Permission denied.", requestId);

    const subscription = await SubscriptionService.getSubscriptionById(req.params.subscriptionId, scope.tenantId);
    return sendSuccess(res, 200, "Subscription retrieved successfully.", subscription, requestId);
  } catch (error) {
    console.error("getSubscription error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to retrieve subscription.", requestId);
  }
};

export const runSubscriptionBillingCycle = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.subscription.manage")) return sendError(res, 403, "Permission denied.", requestId);
    const userId = req.auth?.userId || req.auth?.id || null;

    const subscription = await SubscriptionService.runBillingCycle(req.params.subscriptionId, scope.tenantId, userId || "system");
    return sendSuccess(res, 200, "Subscription billing cycle processed.", subscription, requestId);
  } catch (error) {
    console.error("runSubscriptionBillingCycle error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to process billing cycle.", requestId);
  }
};

export const recordSubscriptionUsage = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.subscription.manage")) return sendError(res, 403, "Permission denied.", requestId);
    const userId = req.auth?.userId || req.auth?.id || null;

    const subscription = await SubscriptionService.recordUsage(req.params.subscriptionId, req.body, scope.tenantId, userId);
    return sendSuccess(res, 200, "Usage recorded successfully.", subscription, requestId);
  } catch (error) {
    console.error("recordSubscriptionUsage error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to record usage.", requestId);
  }
};

export const changeSubscriptionPlan = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.subscription.manage")) return sendError(res, 403, "Permission denied.", requestId);
    const userId = req.auth?.userId || req.auth?.id || null;

    const subscription = await SubscriptionService.changePlan(req.params.subscriptionId, req.body, scope.tenantId, userId);
    return sendSuccess(res, 200, "Subscription plan changed successfully.", subscription, requestId);
  } catch (error) {
    console.error("changeSubscriptionPlan error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to change subscription plan.", requestId);
  }
};

export const pauseSubscription = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.subscription.manage")) return sendError(res, 403, "Permission denied.", requestId);
    const userId = req.auth?.userId || req.auth?.id || null;

    const subscription = await SubscriptionService.pause(req.params.subscriptionId, req.body, scope.tenantId, userId);
    return sendSuccess(res, 200, "Subscription paused successfully.", subscription, requestId);
  } catch (error) {
    console.error("pauseSubscription error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to pause subscription.", requestId);
  }
};

export const resumeSubscription = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.subscription.manage")) return sendError(res, 403, "Permission denied.", requestId);
    const userId = req.auth?.userId || req.auth?.id || null;

    const subscription = await SubscriptionService.resume(req.params.subscriptionId, scope.tenantId, userId);
    return sendSuccess(res, 200, "Subscription resumed successfully.", subscription, requestId);
  } catch (error) {
    console.error("resumeSubscription error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to resume subscription.", requestId);
  }
};

export const cancelSubscription = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.subscription.manage")) return sendError(res, 403, "Permission denied.", requestId);
    const userId = req.auth?.userId || req.auth?.id || null;

    const subscription = await SubscriptionService.cancel(req.params.subscriptionId, req.body, scope.tenantId, userId);
    return sendSuccess(res, 200, "Subscription cancelled successfully.", subscription, requestId);
  } catch (error) {
    console.error("cancelSubscription error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to cancel subscription.", requestId);
  }
};

export const terminateSubscription = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.subscription.manage")) return sendError(res, 403, "Permission denied.", requestId);
    const userId = req.auth?.userId || req.auth?.id || null;

    const subscription = await SubscriptionService.terminate(req.params.subscriptionId, req.body, scope.tenantId, userId);
    return sendSuccess(res, 200, "Subscription terminated successfully.", subscription, requestId);
  } catch (error) {
    console.error("terminateSubscription error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to terminate subscription.", requestId);
  }
};
