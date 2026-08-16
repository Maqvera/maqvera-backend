import SettlementService from "../services/SettlementService.js";
import { sendSuccess, sendError } from "../utils/apiResponse.js";
import { createRequestId } from "../utils/authTokens.js";
import { getAccessScope } from "../utils/accessScope.js";

const hasPermission = (req, ...keys) => {
  const permissions = req.auth?.permissions || [];
  return permissions.includes("admin") || keys.some((key) => permissions.includes(key));
};

const statusFromError = (error) => {
  const message = error.message || "";
  if (message.includes("already")) return 409;
  if (message.includes("not found")) return 404;
  if (message.includes("required") || message.includes("cannot") || message.includes("Cannot") || message.includes("Invalid") || message.includes("must") || message.includes("exceed") || message.includes("not ready") || message.includes("not Active") || message.includes("not supported")) return 400;
  return 500;
};

// ---- Settlements ----

export const createSettlement = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.settlement.create")) return sendError(res, 403, "Permission denied.", requestId);
    const userId = req.auth?.userId || req.auth?.id || null;

    const settlement = await SettlementService.createSettlement(req.body, scope.tenantId, userId);
    return sendSuccess(res, 201, "Settlement created successfully.", settlement, requestId);
  } catch (error) {
    console.error("createSettlement error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to create settlement.", requestId);
  }
};

export const listSettlements = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.settlement.read", "finance.read")) return sendError(res, 403, "Permission denied.", requestId);

    const result = await SettlementService.listSettlements(req.query, scope.tenantId);
    return sendSuccess(res, 200, "Settlements retrieved successfully.", result, requestId);
  } catch (error) {
    console.error("listSettlements error:", error);
    return sendError(res, 500, error.message || "Failed to retrieve settlements.", requestId);
  }
};

export const getSettlement = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.settlement.read", "finance.read")) return sendError(res, 403, "Permission denied.", requestId);

    const settlement = await SettlementService.getSettlementById(req.params.settlementId, scope.tenantId);
    return sendSuccess(res, 200, "Settlement retrieved successfully.", settlement, requestId);
  } catch (error) {
    console.error("getSettlement error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to retrieve settlement.", requestId);
  }
};

export const cancelSettlement = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.settlement.manage")) return sendError(res, 403, "Permission denied.", requestId);
    const userId = req.auth?.userId || req.auth?.id || null;

    const settlement = await SettlementService.cancelSettlement(req.params.settlementId, req.body, scope.tenantId, userId);
    return sendSuccess(res, 200, "Settlement cancelled successfully.", settlement, requestId);
  } catch (error) {
    console.error("cancelSettlement error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to cancel settlement.", requestId);
  }
};

export const completeSettlement = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.settlement.manage")) return sendError(res, 403, "Permission denied.", requestId);
    const userId = req.auth?.userId || req.auth?.id || null;

    const settlement = await SettlementService.completeSettlement(req.params.settlementId, scope.tenantId, userId);
    return sendSuccess(res, 200, "Settlement completion processed.", settlement, requestId);
  } catch (error) {
    console.error("completeSettlement error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to complete settlement.", requestId);
  }
};

export const createSettlementAdjustment = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.settlement.manage")) return sendError(res, 403, "Permission denied.", requestId);
    const userId = req.auth?.userId || req.auth?.id || null;

    const result = await SettlementService.createAdjustment(req.params.settlementId, req.body, scope.tenantId, userId);
    return sendSuccess(res, 201, "Settlement adjustment recorded successfully.", result, requestId);
  } catch (error) {
    console.error("createAdjustment error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to record settlement adjustment.", requestId);
  }
};

export const reconcileSettlements = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.settlement.manage")) return sendError(res, 403, "Permission denied.", requestId);
    const userId = req.auth?.userId || req.auth?.id || null;

    const result = await SettlementService.reconcileSettlements(req.body, scope.tenantId, userId);
    return sendSuccess(res, 200, "Settlement reconciliation completed.", result, requestId);
  } catch (error) {
    console.error("reconcileSettlements error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to reconcile settlements.", requestId);
  }
};

export const fetchGatewaySettlementReport = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.settlement.read", "finance.read")) return sendError(res, 403, "Permission denied.", requestId);

    const { gateway, arrivalDateAfter, arrivalDateBefore } = req.query;
    if (!gateway) return sendError(res, 400, "gateway is required.", requestId);

    const result = await SettlementService.fetchGatewaySettlementReport(gateway, { arrivalDateAfter, arrivalDateBefore });
    return sendSuccess(res, 200, "Gateway settlement report retrieved successfully.", result, requestId);
  } catch (error) {
    console.error("fetchGatewaySettlementReport error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to retrieve gateway settlement report.", requestId);
  }
};

// ---- Batches ----

export const createBatch = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.settlement.manage")) return sendError(res, 403, "Permission denied.", requestId);
    const userId = req.auth?.userId || req.auth?.id || null;

    const batch = await SettlementService.createBatch(req.body, scope.tenantId, userId);
    return sendSuccess(res, 201, "Settlement batch created successfully.", batch, requestId);
  } catch (error) {
    console.error("createBatch error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to create settlement batch.", requestId);
  }
};

export const listBatches = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.settlement.read", "finance.read")) return sendError(res, 403, "Permission denied.", requestId);

    const items = await SettlementService.listBatches(req.query, scope.tenantId);
    return sendSuccess(res, 200, "Settlement batches retrieved successfully.", { items }, requestId);
  } catch (error) {
    console.error("listBatches error:", error);
    return sendError(res, 500, error.message || "Failed to retrieve settlement batches.", requestId);
  }
};

export const getBatch = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.settlement.read", "finance.read")) return sendError(res, 403, "Permission denied.", requestId);

    const batch = await SettlementService.getBatchById(req.params.batchId, scope.tenantId);
    return sendSuccess(res, 200, "Settlement batch retrieved successfully.", batch, requestId);
  } catch (error) {
    console.error("getBatch error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to retrieve settlement batch.", requestId);
  }
};

export const sendBatch = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.settlement.manage")) return sendError(res, 403, "Permission denied.", requestId);
    const userId = req.auth?.userId || req.auth?.id || null;

    const batch = await SettlementService.sendBatch(req.params.batchId, req.body, scope.tenantId, userId);
    return sendSuccess(res, 200, "Settlement batch sent successfully.", batch, requestId);
  } catch (error) {
    console.error("sendBatch error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to send settlement batch.", requestId);
  }
};

export const completeBatch = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.settlement.manage")) return sendError(res, 403, "Permission denied.", requestId);
    const userId = req.auth?.userId || req.auth?.id || null;

    const batch = await SettlementService.completeBatch(req.params.batchId, scope.tenantId, userId);
    return sendSuccess(res, 200, "Settlement batch completion processed.", batch, requestId);
  } catch (error) {
    console.error("completeBatch error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to complete settlement batch.", requestId);
  }
};
