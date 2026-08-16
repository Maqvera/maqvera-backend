import AccountsPayableService from "../services/AccountsPayableService.js";
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
  if (message.includes("required") || message.includes("cannot") || message.includes("Invalid") || message.includes("mismatch") || message.includes("does not")) return 400;
  return 500;
};

export const listPayables = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.payable.read", "finance.read")) return sendError(res, 403, "Permission denied.", requestId);

    const result = await AccountsPayableService.listPayables(req.query, scope.tenantId);
    return sendSuccess(res, 200, "Payables retrieved successfully.", result, requestId);
  } catch (error) {
    console.error("listPayables error:", error);
    return sendError(res, 500, error.message || "Failed to retrieve payables.", requestId);
  }
};

export const getPayable = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.payable.read", "finance.read")) return sendError(res, 403, "Permission denied.", requestId);

    const payable = await AccountsPayableService.getPayableById(req.params.payableId, scope.tenantId);
    return sendSuccess(res, 200, "Payable retrieved successfully.", payable, requestId);
  } catch (error) {
    console.error("getPayable error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to retrieve payable.", requestId);
  }
};

export const createPayable = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.payable.create")) return sendError(res, 403, "Permission denied.", requestId);
    const userId = req.auth?.userId || req.auth?.id || null;

    const payable = await AccountsPayableService.createPayable(req.body, scope.tenantId, userId);
    return sendSuccess(res, 201, "Payable created successfully.", payable, requestId);
  } catch (error) {
    console.error("createPayable error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to create payable.", requestId);
  }
};

export const approvePayable = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.payable.approve")) return sendError(res, 403, "Permission denied.", requestId);
    const userId = req.auth?.userId || req.auth?.id || null;

    const payable = await AccountsPayableService.approvePayable(req.params.payableId, scope.tenantId, userId);
    return sendSuccess(res, 200, "Payable approved successfully.", payable, requestId);
  } catch (error) {
    console.error("approvePayable error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to approve payable.", requestId);
  }
};

export const allocatePayment = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.payable.update")) return sendError(res, 403, "Permission denied.", requestId);
    const userId = req.auth?.userId || req.auth?.id || null;

    const result = await AccountsPayableService.allocatePayment(req.params.payableId, req.body, scope.tenantId, userId);
    return sendSuccess(res, 200, "Payment allocated successfully.", result, requestId);
  } catch (error) {
    console.error("allocatePayment error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to allocate payment.", requestId);
  }
};

export const writeOffPayable = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.payable.writeoff")) return sendError(res, 403, "Permission denied.", requestId);
    const userId = req.auth?.userId || req.auth?.id || null;

    const payable = await AccountsPayableService.writeOff(req.params.payableId, req.body, scope.tenantId, userId);
    return sendSuccess(res, 200, "Payable written off successfully.", payable, requestId);
  } catch (error) {
    console.error("writeOffPayable error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to write off payable.", requestId);
  }
};

export const schedulePayment = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.payable.update")) return sendError(res, 403, "Permission denied.", requestId);
    const userId = req.auth?.userId || req.auth?.id || null;

    const payable = await AccountsPayableService.schedulePayment(req.params.payableId, req.body, scope.tenantId, userId);
    return sendSuccess(res, 200, "Payment scheduled successfully.", payable, requestId);
  } catch (error) {
    console.error("schedulePayment error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to schedule payment.", requestId);
  }
};
