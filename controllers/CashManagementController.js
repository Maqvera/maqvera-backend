import CashManagementService from "../services/CashManagementService.js";
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
  if (message.includes("required") || message.includes("cannot") || message.includes("Cannot") || message.includes("Invalid") || message.includes("exceeds") || message.includes("must be") || message.includes("mismatch") || message.includes("Insufficient")) return 400;
  return 500;
};

// ---- Cash Locations ----

export const listCashLocations = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.cash.read", "finance.read")) return sendError(res, 403, "Permission denied.", requestId);

    const result = await CashManagementService.listCashLocations(req.query, scope.tenantId);
    return sendSuccess(res, 200, "Cash locations retrieved successfully.", result, requestId);
  } catch (error) {
    console.error("listCashLocations error:", error);
    return sendError(res, 500, error.message || "Failed to retrieve cash locations.", requestId);
  }
};

export const getCashLocation = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.cash.read", "finance.read")) return sendError(res, 403, "Permission denied.", requestId);

    const cashLocation = await CashManagementService.getCashLocationById(req.params.cashLocationId, scope.tenantId);
    return sendSuccess(res, 200, "Cash location retrieved successfully.", cashLocation, requestId);
  } catch (error) {
    console.error("getCashLocation error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to retrieve cash location.", requestId);
  }
};

export const createCashLocation = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.cash.create")) return sendError(res, 403, "Permission denied.", requestId);
    const userId = req.auth?.userId || req.auth?.id || null;

    const cashLocation = await CashManagementService.createCashLocation(req.body, scope.tenantId, userId);
    return sendSuccess(res, 201, "Cash location created successfully.", cashLocation, requestId);
  } catch (error) {
    console.error("createCashLocation error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to create cash location.", requestId);
  }
};

export const updateCashLocation = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.cash.manage")) return sendError(res, 403, "Permission denied.", requestId);
    const userId = req.auth?.userId || req.auth?.id || null;

    const cashLocation = await CashManagementService.updateCashLocation(req.params.cashLocationId, req.body, scope.tenantId, userId);
    return sendSuccess(res, 200, "Cash location updated successfully.", cashLocation, requestId);
  } catch (error) {
    console.error("updateCashLocation error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to update cash location.", requestId);
  }
};

export const closeCashLocation = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.cash.manage")) return sendError(res, 403, "Permission denied.", requestId);
    const userId = req.auth?.userId || req.auth?.id || null;

    const cashLocation = await CashManagementService.closeCashLocation(req.params.cashLocationId, req.body, scope.tenantId, userId);
    return sendSuccess(res, 200, "Cash location closed successfully.", cashLocation, requestId);
  } catch (error) {
    console.error("closeCashLocation error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to close cash location.", requestId);
  }
};

export const archiveCashLocation = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.cash.manage")) return sendError(res, 403, "Permission denied.", requestId);
    const userId = req.auth?.userId || req.auth?.id || null;

    const cashLocation = await CashManagementService.archiveCashLocation(req.params.cashLocationId, scope.tenantId, userId);
    return sendSuccess(res, 200, "Cash location archived successfully.", cashLocation, requestId);
  } catch (error) {
    console.error("archiveCashLocation error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to archive cash location.", requestId);
  }
};

export const listCashLocationTransactions = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.cash.read", "finance.read")) return sendError(res, 403, "Permission denied.", requestId);

    const result = await CashManagementService.listCashLocationTransactions(req.params.cashLocationId, req.query, scope.tenantId);
    return sendSuccess(res, 200, "Cash transactions retrieved successfully.", result, requestId);
  } catch (error) {
    console.error("listCashLocationTransactions error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to retrieve cash transactions.", requestId);
  }
};

// ---- Cash Transfers ----

export const listCashTransfers = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.cash.read", "finance.read")) return sendError(res, 403, "Permission denied.", requestId);

    const result = await CashManagementService.listCashTransfers(req.query, scope.tenantId);
    return sendSuccess(res, 200, "Cash transfers retrieved successfully.", result, requestId);
  } catch (error) {
    console.error("listCashTransfers error:", error);
    return sendError(res, 500, error.message || "Failed to retrieve cash transfers.", requestId);
  }
};

export const getCashTransfer = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.cash.read", "finance.read")) return sendError(res, 403, "Permission denied.", requestId);

    const transfer = await CashManagementService.getCashTransferById(req.params.transferId, scope.tenantId);
    return sendSuccess(res, 200, "Cash transfer retrieved successfully.", transfer, requestId);
  } catch (error) {
    console.error("getCashTransfer error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to retrieve cash transfer.", requestId);
  }
};

export const createCashTransfer = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.cash.create")) return sendError(res, 403, "Permission denied.", requestId);
    const userId = req.auth?.userId || req.auth?.id || null;

    const transfer = await CashManagementService.createCashTransfer(req.body, scope.tenantId, userId);
    return sendSuccess(res, 201, "Cash transfer initiated successfully.", transfer, requestId);
  } catch (error) {
    console.error("createCashTransfer error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to initiate cash transfer.", requestId);
  }
};

export const approveCashTransfer = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.cash.approve")) return sendError(res, 403, "Permission denied.", requestId);
    const userId = req.auth?.userId || req.auth?.id || null;

    const transfer = await CashManagementService.approveCashTransfer(req.params.transferId, scope.tenantId, userId);
    return sendSuccess(res, 200, "Cash transfer approved successfully.", transfer, requestId);
  } catch (error) {
    console.error("approveCashTransfer error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to approve cash transfer.", requestId);
  }
};

export const rejectCashTransfer = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.cash.approve")) return sendError(res, 403, "Permission denied.", requestId);
    const userId = req.auth?.userId || req.auth?.id || null;

    const transfer = await CashManagementService.rejectCashTransfer(req.params.transferId, req.body, scope.tenantId, userId);
    return sendSuccess(res, 200, "Cash transfer rejected successfully.", transfer, requestId);
  } catch (error) {
    console.error("rejectCashTransfer error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to reject cash transfer.", requestId);
  }
};

export const cancelCashTransfer = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.cash.create")) return sendError(res, 403, "Permission denied.", requestId);
    const userId = req.auth?.userId || req.auth?.id || null;

    const transfer = await CashManagementService.cancelCashTransfer(req.params.transferId, req.body, scope.tenantId, userId);
    return sendSuccess(res, 200, "Cash transfer cancelled successfully.", transfer, requestId);
  } catch (error) {
    console.error("cancelCashTransfer error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to cancel cash transfer.", requestId);
  }
};

// ---- Cash Counts ----

export const listCashCounts = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.cash.read", "finance.read")) return sendError(res, 403, "Permission denied.", requestId);

    const items = await CashManagementService.listCashCounts(req.query, scope.tenantId);
    return sendSuccess(res, 200, "Cash counts retrieved successfully.", { items }, requestId);
  } catch (error) {
    console.error("listCashCounts error:", error);
    return sendError(res, 500, error.message || "Failed to retrieve cash counts.", requestId);
  }
};

export const getCashCount = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.cash.read", "finance.read")) return sendError(res, 403, "Permission denied.", requestId);

    const count = await CashManagementService.getCashCountById(req.params.countId, scope.tenantId);
    return sendSuccess(res, 200, "Cash count retrieved successfully.", count, requestId);
  } catch (error) {
    console.error("getCashCount error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to retrieve cash count.", requestId);
  }
};

export const createCashCount = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.cash.create")) return sendError(res, 403, "Permission denied.", requestId);
    const userId = req.auth?.userId || req.auth?.id || null;

    const count = await CashManagementService.createCashCount(req.params.cashLocationId, req.body, scope.tenantId, userId);
    return sendSuccess(res, 201, "Cash count recorded successfully.", count, requestId);
  } catch (error) {
    console.error("createCashCount error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to record cash count.", requestId);
  }
};

export const resolveCashCountVariance = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.cash.approve")) return sendError(res, 403, "Permission denied.", requestId);
    const userId = req.auth?.userId || req.auth?.id || null;

    const count = await CashManagementService.resolveCashCountVariance(req.params.countId, req.body, scope.tenantId, userId);
    return sendSuccess(res, 200, "Cash count variance resolved successfully.", count, requestId);
  } catch (error) {
    console.error("resolveCashCountVariance error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to resolve cash count variance.", requestId);
  }
};

// ---- Petty Cash ----

export const listPettyCashAdvances = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.cash.read", "finance.read")) return sendError(res, 403, "Permission denied.", requestId);

    const items = await CashManagementService.listPettyCashAdvances(req.query, scope.tenantId);
    return sendSuccess(res, 200, "Petty cash advances retrieved successfully.", { items }, requestId);
  } catch (error) {
    console.error("listPettyCashAdvances error:", error);
    return sendError(res, 500, error.message || "Failed to retrieve petty cash advances.", requestId);
  }
};

export const getPettyCashAdvance = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.cash.read", "finance.read")) return sendError(res, 403, "Permission denied.", requestId);

    const advance = await CashManagementService.getPettyCashAdvanceById(req.params.advanceId, scope.tenantId);
    return sendSuccess(res, 200, "Petty cash advance retrieved successfully.", advance, requestId);
  } catch (error) {
    console.error("getPettyCashAdvance error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to retrieve petty cash advance.", requestId);
  }
};

export const issuePettyCashAdvance = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.cash.create")) return sendError(res, 403, "Permission denied.", requestId);
    const userId = req.auth?.userId || req.auth?.id || null;

    const advance = await CashManagementService.issuePettyCashAdvance(req.params.cashLocationId, req.body, scope.tenantId, userId);
    return sendSuccess(res, 201, "Petty cash advance issued successfully.", advance, requestId);
  } catch (error) {
    console.error("issuePettyCashAdvance error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to issue petty cash advance.", requestId);
  }
};

export const settlePettyCashAdvance = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.cash.manage")) return sendError(res, 403, "Permission denied.", requestId);
    const userId = req.auth?.userId || req.auth?.id || null;

    const advance = await CashManagementService.settlePettyCashAdvance(req.params.advanceId, req.body, scope.tenantId, userId);
    return sendSuccess(res, 200, "Petty cash advance settled successfully.", advance, requestId);
  } catch (error) {
    console.error("settlePettyCashAdvance error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to settle petty cash advance.", requestId);
  }
};

export const replenishPettyCash = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.cash.manage")) return sendError(res, 403, "Permission denied.", requestId);
    const userId = req.auth?.userId || req.auth?.id || null;

    const cashLocation = await CashManagementService.replenishPettyCash(req.params.cashLocationId, req.body, scope.tenantId, userId);
    return sendSuccess(res, 200, "Petty cash replenished successfully.", cashLocation, requestId);
  } catch (error) {
    console.error("replenishPettyCash error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to replenish petty cash.", requestId);
  }
};

// ---- Forecasting ----

export const forecastCashNeeds = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.cash.read", "finance.read")) return sendError(res, 403, "Permission denied.", requestId);

    const result = await CashManagementService.forecastCashNeeds(req.query, scope.tenantId);
    return sendSuccess(res, 200, "Cash forecast generated.", result, requestId);
  } catch (error) {
    console.error("forecastCashNeeds error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to generate cash forecast.", requestId);
  }
};
