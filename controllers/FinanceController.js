import ChartOfAccountService from "../services/ChartOfAccountService.js";
import { sendSuccess, sendError } from "../utils/apiResponse.js";
import { createRequestId } from "../utils/authTokens.js";
import { getAccessScope } from "../utils/accessScope.js";

const hasPermission = (req, ...keys) => {
  const permissions = req.auth?.permissions || [];
  return permissions.includes("admin") || keys.some((key) => permissions.includes(key));
};

// Local error->status mapping, extended beyond the base substring set
// (see CLAUDE.md) with the business-rule phrasings ChartOfAccountService
// throws ("cannot be modified/deleted", "exceeds the maximum", "violation").
const statusFromError = (error) => {
  const message = error.message || "";
  if (message.includes("already exists")) return 409;
  if (message.includes("not found")) return 404;
  if (message.includes("required") || message.includes("cannot") || message.includes("exceeds") || message.includes("violation")) return 400;
  return 500;
};

/**
 * GET /api/v1/accounts
 */
export const listAccounts = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.account.read", "finance.read")) {
      return sendError(res, 403, "Permission denied.", requestId);
    }

    const result = await ChartOfAccountService.listAccounts(req.query, scope.tenantId);
    return sendSuccess(res, 200, "Chart of Accounts retrieved successfully.", result, requestId);
  } catch (error) {
    console.error("listAccounts error:", error);
    return sendError(res, 500, error.message || "Failed to retrieve Chart of Accounts.", requestId);
  }
};

/**
 * GET /api/v1/accounts/:accountId
 */
export const getAccount = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.account.read", "finance.read")) {
      return sendError(res, 403, "Permission denied.", requestId);
    }

    const account = await ChartOfAccountService.getAccountById(req.params.accountId, scope.tenantId);
    return sendSuccess(res, 200, "Account retrieved successfully.", account, requestId);
  } catch (error) {
    console.error("getAccount error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to retrieve account.", requestId);
  }
};

/**
 * POST /api/v1/accounts
 */
export const createAccount = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.account.create")) {
      return sendError(res, 403, "Permission denied.", requestId);
    }
    const userId = req.auth?.userId || req.auth?.id || null;

    const account = await ChartOfAccountService.createAccount(req.body, scope.tenantId, userId);
    return sendSuccess(res, 201, "Account created successfully.", account, requestId);
  } catch (error) {
    console.error("createAccount error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to create account.", requestId);
  }
};

/**
 * PATCH /api/v1/accounts/:accountId
 */
export const updateAccount = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.account.update")) {
      return sendError(res, 403, "Permission denied.", requestId);
    }
    const userId = req.auth?.userId || req.auth?.id || null;

    const account = await ChartOfAccountService.updateAccount(req.params.accountId, req.body, scope.tenantId, userId);
    return sendSuccess(res, 200, "Account updated successfully.", account, requestId);
  } catch (error) {
    console.error("updateAccount error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to update account.", requestId);
  }
};

/**
 * DELETE /api/v1/accounts/:accountId — soft delete (status -> Inactive).
 */
export const deactivateAccount = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.account.delete")) {
      return sendError(res, 403, "Permission denied.", requestId);
    }
    const userId = req.auth?.userId || req.auth?.id || null;

    const account = await ChartOfAccountService.deactivateAccount(req.params.accountId, scope.tenantId, userId);
    return sendSuccess(res, 200, "Account deactivated successfully.", account, requestId);
  } catch (error) {
    console.error("deactivateAccount error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to deactivate account.", requestId);
  }
};

/**
 * POST /api/v1/accounts/:accountId/reactivate (Part 36)
 */
export const reactivateAccount = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.account.update")) return sendError(res, 403, "Permission denied.", requestId);
    const userId = req.auth?.userId || req.auth?.id || null;

    const account = await ChartOfAccountService.reactivateAccount(req.params.accountId, scope.tenantId, userId);
    return sendSuccess(res, 200, "Account reactivated successfully.", account, requestId);
  } catch (error) {
    console.error("reactivateAccount error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to reactivate account.", requestId);
  }
};

/**
 * POST /api/v1/accounts/:accountId/suspend (Part 36)
 */
export const suspendAccount = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.account.update")) return sendError(res, 403, "Permission denied.", requestId);
    const userId = req.auth?.userId || req.auth?.id || null;

    const account = await ChartOfAccountService.suspendAccount(req.params.accountId, req.body, scope.tenantId, userId);
    return sendSuccess(res, 200, "Account suspended successfully.", account, requestId);
  } catch (error) {
    console.error("suspendAccount error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to suspend account.", requestId);
  }
};

/**
 * POST /api/v1/accounts/:accountId/archive (Part 36)
 */
export const archiveAccount = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.account.update")) return sendError(res, 403, "Permission denied.", requestId);
    const userId = req.auth?.userId || req.auth?.id || null;

    const account = await ChartOfAccountService.archiveAccount(req.params.accountId, scope.tenantId, userId);
    return sendSuccess(res, 200, "Account archived successfully.", account, requestId);
  } catch (error) {
    console.error("archiveAccount error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to archive account.", requestId);
  }
};

/**
 * POST /api/v1/accounts/:accountId/merge (Part 36) — bulk/structural,
 * gated on finance.account.manage rather than the narrower .update.
 */
export const mergeAccounts = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.account.manage")) return sendError(res, 403, "Permission denied.", requestId);
    const userId = req.auth?.userId || req.auth?.id || null;

    const account = await ChartOfAccountService.mergeAccounts(req.params.accountId, req.body, scope.tenantId, userId);
    return sendSuccess(res, 200, "Accounts merged successfully.", account, requestId);
  } catch (error) {
    console.error("mergeAccounts error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to merge accounts.", requestId);
  }
};

// ---- Chart of Account Templates (Part 36) ----

export const listAccountTemplates = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.account.read", "finance.read")) return sendError(res, 403, "Permission denied.", requestId);

    const templates = await ChartOfAccountService.listTemplates(req.query, scope.tenantId);
    return sendSuccess(res, 200, "Chart templates retrieved successfully.", templates, requestId);
  } catch (error) {
    console.error("listAccountTemplates error:", error);
    return sendError(res, 500, error.message || "Failed to retrieve chart templates.", requestId);
  }
};

export const getAccountTemplate = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.account.read", "finance.read")) return sendError(res, 403, "Permission denied.", requestId);

    const template = await ChartOfAccountService.getTemplateById(req.params.templateId, scope.tenantId);
    return sendSuccess(res, 200, "Chart template retrieved successfully.", template, requestId);
  } catch (error) {
    console.error("getAccountTemplate error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to retrieve chart template.", requestId);
  }
};

export const createAccountTemplate = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.account.manage")) return sendError(res, 403, "Permission denied.", requestId);
    const userId = req.auth?.userId || req.auth?.id || null;

    const template = await ChartOfAccountService.createTemplate(req.body, scope.tenantId, userId);
    return sendSuccess(res, 201, "Chart template created successfully.", template, requestId);
  } catch (error) {
    console.error("createAccountTemplate error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to create chart template.", requestId);
  }
};

export const applyAccountTemplate = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.account.manage")) return sendError(res, 403, "Permission denied.", requestId);
    const userId = req.auth?.userId || req.auth?.id || null;

    const result = await ChartOfAccountService.applyTemplate(req.params.templateId, scope.tenantId, userId);
    return sendSuccess(res, 200, "Chart template applied successfully.", result, requestId);
  } catch (error) {
    console.error("applyAccountTemplate error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to apply chart template.", requestId);
  }
};
