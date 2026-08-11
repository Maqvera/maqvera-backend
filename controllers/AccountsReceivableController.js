import AccountsReceivableService from "../services/AccountsReceivableService.js";
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
  if (message.includes("required") || message.includes("cannot") || message.includes("exceeded") || message.includes("mismatch") || message.includes("does not")) return 400;
  return 500;
};

export const listReceivables = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.receivable.read", "finance.read")) return sendError(res, 403, "Permission denied.", requestId);

    const result = await AccountsReceivableService.listReceivables(req.query, scope.tenantId);
    return sendSuccess(res, 200, "Receivables retrieved successfully.", result, requestId);
  } catch (error) {
    console.error("listReceivables error:", error);
    return sendError(res, 500, error.message || "Failed to retrieve receivables.", requestId);
  }
};

export const getReceivable = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.receivable.read", "finance.read")) return sendError(res, 403, "Permission denied.", requestId);

    const receivable = await AccountsReceivableService.getReceivableById(req.params.receivableId, scope.tenantId);
    return sendSuccess(res, 200, "Receivable retrieved successfully.", receivable, requestId);
  } catch (error) {
    console.error("getReceivable error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to retrieve receivable.", requestId);
  }
};

export const createReceivable = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.receivable.create")) return sendError(res, 403, "Permission denied.", requestId);
    const userId = req.auth?.userId || req.auth?.id || null;

    const receivable = await AccountsReceivableService.createReceivable(req.body, scope.tenantId, userId);
    return sendSuccess(res, 201, "Receivable created successfully.", receivable, requestId);
  } catch (error) {
    console.error("createReceivable error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to create receivable.", requestId);
  }
};

export const allocatePayment = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.receivable.update")) return sendError(res, 403, "Permission denied.", requestId);
    const userId = req.auth?.userId || req.auth?.id || null;

    const result = await AccountsReceivableService.allocatePayment(req.params.receivableId, req.body, scope.tenantId, userId);
    return sendSuccess(res, 200, "Payment allocated successfully.", result, requestId);
  } catch (error) {
    console.error("allocatePayment error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to allocate payment.", requestId);
  }
};

export const writeOffReceivable = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.receivable.writeoff")) return sendError(res, 403, "Permission denied.", requestId);
    const userId = req.auth?.userId || req.auth?.id || null;

    const receivable = await AccountsReceivableService.writeOff(req.params.receivableId, req.body, scope.tenantId, userId);
    return sendSuccess(res, 200, "Receivable written off successfully.", receivable, requestId);
  } catch (error) {
    console.error("writeOffReceivable error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to write off receivable.", requestId);
  }
};
