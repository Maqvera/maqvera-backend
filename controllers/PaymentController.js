import PaymentService from "../services/PaymentService.js";
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
  if (message.includes("required") || message.includes("enough") || message.includes("cannot") || message.includes("not yet supported") || message.includes("Invalid") || message.includes("exceeds") || message.includes("mismatch") || message.includes("does not")) return 400;
  return 500;
};

/**
 * Enterprise Payment Engine — Finance Module Part 7. Every module that
 * moves money (AR, AP, and eventually Booking/Visa/Travel/Payroll/
 * Subscriptions) calls into this as a "specialized workflow," per the
 * spec's own architecture review — the payment record represents the
 * movement of money, not why it exists.
 */
export const listPayments = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.payment.read", "finance.read")) return sendError(res, 403, "Permission denied.", requestId);

    const result = await PaymentService.listPayments(req.query, scope.tenantId);
    return sendSuccess(res, 200, "Payments retrieved successfully.", result, requestId);
  } catch (error) {
    console.error("listPayments error:", error);
    return sendError(res, 500, error.message || "Failed to retrieve payments.", requestId);
  }
};

export const getPayment = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.payment.read", "finance.read")) return sendError(res, 403, "Permission denied.", requestId);

    const payment = await PaymentService.getPaymentById(req.params.paymentId, scope.tenantId);
    return sendSuccess(res, 200, "Payment retrieved successfully.", payment.toJSON ? payment.toJSON() : payment, requestId);
  } catch (error) {
    console.error("getPayment error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to retrieve payment.", requestId);
  }
};

export const createPayment = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.payment.create")) return sendError(res, 403, "Permission denied.", requestId);
    const userId = req.auth?.userId || req.auth?.id || null;

    const payment = await PaymentService.createPayment(req.body, scope.tenantId, userId);
    return sendSuccess(res, payment.status === "Failed" ? 402 : 201, payment.status === "Failed" ? "Payment failed." : "Payment recorded successfully.", payment, requestId);
  } catch (error) {
    console.error("createPayment error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to record payment.", requestId);
  }
};

export const allocatePayment = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.payment.allocate")) return sendError(res, 403, "Permission denied.", requestId);
    const userId = req.auth?.userId || req.auth?.id || null;

    const result = await PaymentService.allocate(req.params.paymentId, req.body, scope.tenantId, userId);
    return sendSuccess(res, 200, "Payment allocated successfully.", result, requestId);
  } catch (error) {
    console.error("allocatePayment error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to allocate payment.", requestId);
  }
};

export const voidPayment = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.payment.void")) return sendError(res, 403, "Permission denied.", requestId);
    const userId = req.auth?.userId || req.auth?.id || null;

    const payment = await PaymentService.void(req.params.paymentId, req.body, scope.tenantId, userId);
    return sendSuccess(res, 200, "Payment voided successfully.", payment, requestId);
  } catch (error) {
    console.error("voidPayment error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to void payment.", requestId);
  }
};

export const refundPayment = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.payment.refund")) return sendError(res, 403, "Permission denied.", requestId);
    const userId = req.auth?.userId || req.auth?.id || null;

    const payment = await PaymentService.refund(req.params.paymentId, req.body, scope.tenantId, userId);
    return sendSuccess(res, 200, "Payment refunded successfully.", payment, requestId);
  } catch (error) {
    console.error("refundPayment error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to refund payment.", requestId);
  }
};

/** POST /api/v1/payments/{paymentId}/retry — "Manual Retry" (Part 18 Part 5's own Payment Retry Engine). */
export const retryPayment = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.payment.create")) return sendError(res, 403, "Permission denied.", requestId);
    const userId = req.auth?.userId || req.auth?.id || null;

    const payment = await PaymentService.retryPayment(req.params.paymentId, scope.tenantId, userId);
    return sendSuccess(res, payment.status === "Failed" ? 402 : 201, "Payment retried.", payment, requestId);
  } catch (error) {
    console.error("retryPayment error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to retry payment.", requestId);
  }
};
