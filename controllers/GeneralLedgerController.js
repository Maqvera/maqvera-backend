import LedgerService from "../services/LedgerService.js";
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
  if (message.includes("required")) return 400;
  return 500;
};

export const listLedgerEntries = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.ledger.read", "finance.read")) return sendError(res, 403, "Permission denied.", requestId);

    const result = await LedgerService.listEntries(req.query, scope.tenantId);
    return sendSuccess(res, 200, "Ledger entries retrieved successfully.", result, requestId);
  } catch (error) {
    console.error("listLedgerEntries error:", error);
    return sendError(res, 500, error.message || "Failed to retrieve ledger entries.", requestId);
  }
};

export const getAccountBalance = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.ledger.read", "finance.read")) return sendError(res, 403, "Permission denied.", requestId);

    const balance = await LedgerService.getAccountBalance(req.params.accountId, scope.tenantId, { asOfDate: req.query.asOfDate });
    return sendSuccess(res, 200, "Account balance retrieved successfully.", balance, requestId);
  } catch (error) {
    console.error("getAccountBalance error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to retrieve account balance.", requestId);
  }
};

export const getTrialBalance = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.ledger.read", "finance.read")) return sendError(res, 403, "Permission denied.", requestId);

    const trialBalance = await LedgerService.getTrialBalance(req.query, scope.tenantId);
    return sendSuccess(res, 200, "Trial balance retrieved successfully.", trialBalance, requestId);
  } catch (error) {
    console.error("getTrialBalance error:", error);
    return sendError(res, 500, error.message || "Failed to retrieve trial balance.", requestId);
  }
};

/**
 * POST /api/v1/general-ledger/recalculate — "Administrator only" is an
 * explicit business rule in the spec, so this checks the `admin` permission
 * directly rather than a granular finance.* key.
 */
export const recalculateLedger = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    const permissions = req.auth?.permissions || [];
    if (!permissions.includes("admin")) return sendError(res, 403, "Administrator permission required.", requestId);
    const userId = req.auth?.userId || req.auth?.id || null;

    const result = await LedgerService.recalculate(scope.tenantId, userId);
    return sendSuccess(res, 200, "Ledger balances recalculated successfully.", result, requestId);
  } catch (error) {
    console.error("recalculateLedger error:", error);
    return sendError(res, 500, error.message || "Failed to recalculate ledger balances.", requestId);
  }
};
