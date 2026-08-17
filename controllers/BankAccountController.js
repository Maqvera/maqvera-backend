import BankAccountService from "../services/BankAccountService.js";
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
  if (message.includes("required") || message.includes("cannot") || message.includes("Cannot") || message.includes("Invalid") || message.includes("exceeds") || message.includes("must be") || message.includes("mismatch")) return 400;
  return 500;
};

export const listBankAccounts = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.bankaccount.read", "finance.read")) return sendError(res, 403, "Permission denied.", requestId);

    const result = await BankAccountService.listBankAccounts(req.query, scope.tenantId);
    return sendSuccess(res, 200, "Bank accounts retrieved successfully.", result, requestId);
  } catch (error) {
    console.error("listBankAccounts error:", error);
    return sendError(res, 500, error.message || "Failed to retrieve bank accounts.", requestId);
  }
};

export const getBankAccount = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.bankaccount.read", "finance.read")) return sendError(res, 403, "Permission denied.", requestId);

    const bankAccount = await BankAccountService.getBankAccountById(req.params.accountId, scope.tenantId);
    return sendSuccess(res, 200, "Bank account retrieved successfully.", bankAccount, requestId);
  } catch (error) {
    console.error("getBankAccount error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to retrieve bank account.", requestId);
  }
};

export const createBankAccount = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.bankaccount.create")) return sendError(res, 403, "Permission denied.", requestId);
    const userId = req.auth?.userId || req.auth?.id || null;

    const bankAccount = await BankAccountService.createBankAccount(req.body, scope.tenantId, userId);
    return sendSuccess(res, 201, "Bank account created successfully.", bankAccount, requestId);
  } catch (error) {
    console.error("createBankAccount error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to create bank account.", requestId);
  }
};

export const updateBankAccount = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.bankaccount.manage")) return sendError(res, 403, "Permission denied.", requestId);
    const userId = req.auth?.userId || req.auth?.id || null;

    const bankAccount = await BankAccountService.updateBankAccount(req.params.accountId, req.body, scope.tenantId, userId);
    return sendSuccess(res, 200, "Bank account updated successfully.", bankAccount, requestId);
  } catch (error) {
    console.error("updateBankAccount error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to update bank account.", requestId);
  }
};

export const verifyBankAccount = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.bankaccount.approve")) return sendError(res, 403, "Permission denied.", requestId);
    const userId = req.auth?.userId || req.auth?.id || null;

    const bankAccount = await BankAccountService.verifyBankAccount(req.params.accountId, scope.tenantId, userId);
    return sendSuccess(res, 200, "Bank account verified successfully.", bankAccount, requestId);
  } catch (error) {
    console.error("verifyBankAccount error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to verify bank account.", requestId);
  }
};

export const activateBankAccount = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.bankaccount.approve")) return sendError(res, 403, "Permission denied.", requestId);
    const userId = req.auth?.userId || req.auth?.id || null;

    const bankAccount = await BankAccountService.activateBankAccount(req.params.accountId, scope.tenantId, userId);
    return sendSuccess(res, 200, "Bank account activated successfully.", bankAccount, requestId);
  } catch (error) {
    console.error("activateBankAccount error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to activate bank account.", requestId);
  }
};

export const freezeBankAccount = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.bankaccount.manage")) return sendError(res, 403, "Permission denied.", requestId);
    const userId = req.auth?.userId || req.auth?.id || null;

    const bankAccount = await BankAccountService.freezeBankAccount(req.params.accountId, req.body, scope.tenantId, userId);
    return sendSuccess(res, 200, "Bank account frozen successfully.", bankAccount, requestId);
  } catch (error) {
    console.error("freezeBankAccount error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to freeze bank account.", requestId);
  }
};

export const reopenBankAccount = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.bankaccount.manage")) return sendError(res, 403, "Permission denied.", requestId);
    const userId = req.auth?.userId || req.auth?.id || null;

    const bankAccount = await BankAccountService.reopenBankAccount(req.params.accountId, scope.tenantId, userId);
    return sendSuccess(res, 200, "Bank account reopened successfully.", bankAccount, requestId);
  } catch (error) {
    console.error("reopenBankAccount error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to reopen bank account.", requestId);
  }
};

export const suspendBankAccount = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.bankaccount.manage")) return sendError(res, 403, "Permission denied.", requestId);
    const userId = req.auth?.userId || req.auth?.id || null;

    const bankAccount = await BankAccountService.suspendBankAccount(req.params.accountId, req.body, scope.tenantId, userId);
    return sendSuccess(res, 200, "Bank account suspended successfully.", bankAccount, requestId);
  } catch (error) {
    console.error("suspendBankAccount error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to suspend bank account.", requestId);
  }
};

export const closeBankAccount = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.bankaccount.manage")) return sendError(res, 403, "Permission denied.", requestId);
    const userId = req.auth?.userId || req.auth?.id || null;

    const bankAccount = await BankAccountService.closeBankAccount(req.params.accountId, req.body, scope.tenantId, userId);
    return sendSuccess(res, 200, "Bank account closed successfully.", bankAccount, requestId);
  } catch (error) {
    console.error("closeBankAccount error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to close bank account.", requestId);
  }
};

export const archiveBankAccount = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.bankaccount.manage")) return sendError(res, 403, "Permission denied.", requestId);
    const userId = req.auth?.userId || req.auth?.id || null;

    const bankAccount = await BankAccountService.archiveBankAccount(req.params.accountId, scope.tenantId, userId);
    return sendSuccess(res, 200, "Bank account archived successfully.", bankAccount, requestId);
  } catch (error) {
    console.error("archiveBankAccount error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to archive bank account.", requestId);
  }
};

export const adjustBalance = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.bankaccount.manage")) return sendError(res, 403, "Permission denied.", requestId);
    const userId = req.auth?.userId || req.auth?.id || null;

    const result = await BankAccountService.manualAdjustment(req.params.accountId, req.body, scope.tenantId, userId);
    return sendSuccess(res, 200, "Balance adjusted successfully.", result.bankAccount, requestId);
  } catch (error) {
    console.error("adjustBalance error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to adjust balance.", requestId);
  }
};

export const holdFunds = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.bankaccount.manage")) return sendError(res, 403, "Permission denied.", requestId);
    const userId = req.auth?.userId || req.auth?.id || null;

    const bankAccount = await BankAccountService.hold(req.params.accountId, req.body, scope.tenantId, userId);
    return sendSuccess(res, 200, "Funds held successfully.", bankAccount, requestId);
  } catch (error) {
    console.error("holdFunds error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to hold funds.", requestId);
  }
};

export const releaseHold = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.bankaccount.manage")) return sendError(res, 403, "Permission denied.", requestId);
    const userId = req.auth?.userId || req.auth?.id || null;

    const bankAccount = await BankAccountService.releaseHold(req.params.accountId, req.body, scope.tenantId, userId);
    return sendSuccess(res, 200, "Hold released successfully.", bankAccount, requestId);
  } catch (error) {
    console.error("releaseHold error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to release hold.", requestId);
  }
};

export const createVirtualAccount = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.bankaccount.create")) return sendError(res, 403, "Permission denied.", requestId);
    const userId = req.auth?.userId || req.auth?.id || null;

    const virtualAccount = await BankAccountService.createVirtualAccount(req.params.accountId, req.body, scope.tenantId, userId);
    return sendSuccess(res, 201, "Virtual account created successfully.", virtualAccount, requestId);
  } catch (error) {
    console.error("createVirtualAccount error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to create virtual account.", requestId);
  }
};

export const linkSettlementAccount = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.bankaccount.manage")) return sendError(res, 403, "Permission denied.", requestId);
    const userId = req.auth?.userId || req.auth?.id || null;

    const bankAccount = await BankAccountService.linkSettlementAccount(req.params.accountId, req.body, scope.tenantId, userId);
    return sendSuccess(res, 200, "Settlement account linked successfully.", bankAccount, requestId);
  } catch (error) {
    console.error("linkSettlementAccount error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to link settlement account.", requestId);
  }
};

export const listBankTransactions = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.bankaccount.read", "finance.read")) return sendError(res, 403, "Permission denied.", requestId);

    const result = await BankAccountService.listTransactions(req.params.accountId, req.query, scope.tenantId);
    return sendSuccess(res, 200, "Bank transactions retrieved successfully.", result, requestId);
  } catch (error) {
    console.error("listBankTransactions error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to retrieve bank transactions.", requestId);
  }
};
