import RefundService from "../services/RefundService.js";
import { sendSuccess, sendError } from "../utils/apiResponse.js";
import { createRequestId } from "../utils/authTokens.js";
import { getAccessScope } from "../utils/accessScope.js";

const hasPermission = (req, ...keys) => {
  const permissions = req.auth?.permissions || [];
  return permissions.includes("admin") || keys.some((key) => permissions.includes(key));
};

const statusFromError = (error) => {
  const message = error.message || "";
  if (message.includes("already exists")) return 409;
  if (message.includes("not found")) return 404;
  if (message.includes("required") || message.includes("cannot") || message.includes("Cannot") || message.includes("Invalid") || message.includes("exceeds") || message.includes("must be")) return 400;
  return 500;
};

export const listRefunds = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.refund.read", "finance.read")) return sendError(res, 403, "Permission denied.", requestId);

    const result = await RefundService.listRefunds(req.query, scope.tenantId);
    return sendSuccess(res, 200, "Refunds retrieved successfully.", result, requestId);
  } catch (error) {
    console.error("listRefunds error:", error);
    return sendError(res, 500, error.message || "Failed to retrieve refunds.", requestId);
  }
};

export const getRefund = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.refund.read", "finance.read")) return sendError(res, 403, "Permission denied.", requestId);

    const refund = await RefundService.getRefundById(req.params.refundId, scope.tenantId);
    return sendSuccess(res, 200, "Refund retrieved successfully.", refund, requestId);
  } catch (error) {
    console.error("getRefund error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to retrieve refund.", requestId);
  }
};

export const createRefund = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.refund.create")) return sendError(res, 403, "Permission denied.", requestId);
    const userId = req.auth?.userId || req.auth?.id || null;

    const refund = await RefundService.createRefund(req.body, scope.tenantId, userId);
    return sendSuccess(res, 201, "Refund created successfully.", refund, requestId);
  } catch (error) {
    console.error("createRefund error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to create refund.", requestId);
  }
};

export const reviewRefund = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.refund.approve")) return sendError(res, 403, "Permission denied.", requestId);
    const userId = req.auth?.userId || req.auth?.id || null;

    const refund = await RefundService.reviewRefund(req.params.refundId, scope.tenantId, userId);
    return sendSuccess(res, 200, "Refund moved to review successfully.", refund, requestId);
  } catch (error) {
    console.error("reviewRefund error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to move refund to review.", requestId);
  }
};

export const approveRefund = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.refund.approve")) return sendError(res, 403, "Permission denied.", requestId);
    const userId = req.auth?.userId || req.auth?.id || null;

    const refund = await RefundService.approveRefund(req.params.refundId, scope.tenantId, userId);
    return sendSuccess(res, 200, "Refund approved successfully.", refund, requestId);
  } catch (error) {
    console.error("approveRefund error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to approve refund.", requestId);
  }
};

export const rejectRefund = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.refund.approve")) return sendError(res, 403, "Permission denied.", requestId);
    const userId = req.auth?.userId || req.auth?.id || null;

    const refund = await RefundService.rejectRefund(req.params.refundId, req.body, scope.tenantId, userId);
    return sendSuccess(res, 200, "Refund rejected successfully.", refund, requestId);
  } catch (error) {
    console.error("rejectRefund error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to reject refund.", requestId);
  }
};

export const processRefund = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.refund.process")) return sendError(res, 403, "Permission denied.", requestId);
    const userId = req.auth?.userId || req.auth?.id || null;

    const refund = await RefundService.processRefund(req.params.refundId, scope.tenantId, userId);
    return sendSuccess(res, 200, "Refund processed successfully.", refund, requestId);
  } catch (error) {
    console.error("processRefund error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to process refund.", requestId);
  }
};

export const cancelRefund = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.refund.cancel")) return sendError(res, 403, "Permission denied.", requestId);
    const userId = req.auth?.userId || req.auth?.id || null;

    const refund = await RefundService.cancelRefund(req.params.refundId, req.body, scope.tenantId, userId);
    return sendSuccess(res, 200, "Refund cancelled successfully.", refund, requestId);
  } catch (error) {
    console.error("cancelRefund error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to cancel refund.", requestId);
  }
};
