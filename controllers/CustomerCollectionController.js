import CustomerCollectionService from "../services/CustomerCollectionService.js";
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
  if (message.includes("required") || message.includes("cannot") || message.includes("Cannot") || message.includes("Invalid") || message.includes("exceeds") || message.includes("must be") || message.includes("mismatch") || message.includes("expired") || message.includes("no remaining balance") || message.includes("no outstanding balance")) return 400;
  return 500;
};

// ---- Collection Requests ----

export const createCollectionRequest = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.customercollection.create")) return sendError(res, 403, "Permission denied.", requestId);
    const userId = req.auth?.userId || req.auth?.id || null;

    const collection = await CustomerCollectionService.createCollectionRequest(req.body, scope.tenantId, userId);
    return sendSuccess(res, 201, "Customer collection request created successfully.", collection, requestId);
  } catch (error) {
    console.error("createCollectionRequest error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to create customer collection request.", requestId);
  }
};

export const listCollections = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.customercollection.read", "finance.read")) return sendError(res, 403, "Permission denied.", requestId);

    const result = await CustomerCollectionService.listCollections(req.query, scope.tenantId);
    return sendSuccess(res, 200, "Customer collections retrieved successfully.", result, requestId);
  } catch (error) {
    console.error("listCollections error:", error);
    return sendError(res, 500, error.message || "Failed to retrieve customer collections.", requestId);
  }
};

export const getCollectionAnalytics = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.customercollection.read", "finance.read")) return sendError(res, 403, "Permission denied.", requestId);

    const result = await CustomerCollectionService.getCollectionAnalytics(scope.tenantId);
    return sendSuccess(res, 200, "Collection analytics generated successfully.", result, requestId);
  } catch (error) {
    console.error("getCollectionAnalytics error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to generate collection analytics.", requestId);
  }
};

export const getCollection = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.customercollection.read", "finance.read")) return sendError(res, 403, "Permission denied.", requestId);

    const collection = await CustomerCollectionService.getCollectionById(req.params.collectionId, scope.tenantId);
    return sendSuccess(res, 200, "Customer collection retrieved successfully.", collection, requestId);
  } catch (error) {
    console.error("getCollection error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to retrieve customer collection.", requestId);
  }
};

export const collectPayment = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.customercollection.manage")) return sendError(res, 403, "Permission denied.", requestId);
    const userId = req.auth?.userId || req.auth?.id || null;

    const collection = await CustomerCollectionService.collectPayment(req.params.collectionId, req.body, scope.tenantId, userId);
    return sendSuccess(res, 200, "Payment collection processed.", collection, requestId);
  } catch (error) {
    console.error("collectPayment error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to process payment collection.", requestId);
  }
};

export const disputeCollection = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.customercollection.manage")) return sendError(res, 403, "Permission denied.", requestId);
    const userId = req.auth?.userId || req.auth?.id || null;

    const collection = await CustomerCollectionService.disputeCollection(req.params.collectionId, req.body, scope.tenantId, userId);
    return sendSuccess(res, 200, "Customer collection disputed successfully.", collection, requestId);
  } catch (error) {
    console.error("disputeCollection error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to dispute customer collection.", requestId);
  }
};

export const writeOffCollection = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.customercollection.approve")) return sendError(res, 403, "Permission denied.", requestId);
    const userId = req.auth?.userId || req.auth?.id || null;

    const result = await CustomerCollectionService.writeOffCollection(req.params.collectionId, req.body, scope.tenantId, userId);
    return sendSuccess(res, 200, "Customer collection written off successfully.", result, requestId);
  } catch (error) {
    console.error("writeOffCollection error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to write off customer collection.", requestId);
  }
};

export const cancelCollection = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.customercollection.manage")) return sendError(res, 403, "Permission denied.", requestId);
    const userId = req.auth?.userId || req.auth?.id || null;

    const collection = await CustomerCollectionService.cancelCollection(req.params.collectionId, req.body, scope.tenantId, userId);
    return sendSuccess(res, 200, "Customer collection cancelled successfully.", collection, requestId);
  } catch (error) {
    console.error("cancelCollection error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to cancel customer collection.", requestId);
  }
};

export const closeCollection = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.customercollection.manage")) return sendError(res, 403, "Permission denied.", requestId);
    const userId = req.auth?.userId || req.auth?.id || null;

    const collection = await CustomerCollectionService.closeCollection(req.params.collectionId, scope.tenantId, userId);
    return sendSuccess(res, 200, "Customer collection closed successfully.", collection, requestId);
  } catch (error) {
    console.error("closeCollection error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to close customer collection.", requestId);
  }
};

// ---- Installment Plans ----

export const createInstallmentPlan = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.customercollection.manage")) return sendError(res, 403, "Permission denied.", requestId);
    const userId = req.auth?.userId || req.auth?.id || null;

    const collection = await CustomerCollectionService.createInstallmentPlan(req.params.collectionId, req.body, scope.tenantId, userId);
    return sendSuccess(res, 201, "Installment plan created successfully.", collection, requestId);
  } catch (error) {
    console.error("createInstallmentPlan error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to create installment plan.", requestId);
  }
};

// ---- Payment Links ----

export const generatePaymentLink = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.customercollection.manage")) return sendError(res, 403, "Permission denied.", requestId);
    const userId = req.auth?.userId || req.auth?.id || null;

    const collection = await CustomerCollectionService.generatePaymentLink(req.params.collectionId, scope.tenantId, userId);
    return sendSuccess(res, 201, "Payment link generated successfully.", collection, requestId);
  } catch (error) {
    console.error("generatePaymentLink error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to generate payment link.", requestId);
  }
};

/**
 * Public — resolved by the unguessable payment-link token, registered
 * BEFORE router.use(authenticateAccessToken), same convention as Part 8's
 * own GET /receipts/verify/:token. GET-only by design — see
 * CustomerCollectionService.getCollectionByToken's own doc comment.
 */
export const viewCollectionByToken = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const result = await CustomerCollectionService.getCollectionByToken(req.params.token);
    return sendSuccess(res, 200, "Payment link details retrieved successfully.", result, requestId);
  } catch (error) {
    console.error("viewCollectionByToken error:", error);
    return sendError(res, statusFromError(error), error.message || "Payment link not found.", requestId);
  }
};

// ---- Reminders ----

export const sendReminder = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.customercollection.manage")) return sendError(res, 403, "Permission denied.", requestId);
    const userId = req.auth?.userId || req.auth?.id || null;

    const reminder = await CustomerCollectionService.sendReminder(req.params.collectionId, req.body, scope.tenantId, userId);
    return sendSuccess(res, 201, "Reminder sent.", reminder, requestId);
  } catch (error) {
    console.error("sendReminder error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to send reminder.", requestId);
  }
};

export const listCollectionReminders = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.customercollection.read", "finance.read")) return sendError(res, 403, "Permission denied.", requestId);

    const items = await CustomerCollectionService.listCollectionReminders(req.params.collectionId, scope.tenantId);
    return sendSuccess(res, 200, "Collection reminders retrieved successfully.", { items }, requestId);
  } catch (error) {
    console.error("listCollectionReminders error:", error);
    return sendError(res, 500, error.message || "Failed to retrieve collection reminders.", requestId);
  }
};

// ---- Advance Customer Deposits ----

export const createCustomerDeposit = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.customercollection.create")) return sendError(res, 403, "Permission denied.", requestId);
    const userId = req.auth?.userId || req.auth?.id || null;

    const result = await CustomerCollectionService.createCustomerDeposit(req.body, scope.tenantId, userId);
    return sendSuccess(res, 201, "Customer deposit created successfully.", result, requestId);
  } catch (error) {
    console.error("createCustomerDeposit error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to create customer deposit.", requestId);
  }
};
