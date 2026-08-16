import WalletService from "../services/WalletService.js";
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
  if (message.includes("already exists")) return 409;
  if (message.includes("required") || message.includes("Insufficient") || message.includes("Invalid") || message.includes("mismatch") || message.includes("not supported") || message.includes("not usable") || message.includes("must be") || message.includes("Cannot") || message.includes("exceed")) return 400;
  return 500;
};

export const createWallet = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.wallet.create")) return sendError(res, 403, "Permission denied.", requestId);
    const userId = req.auth?.userId || req.auth?.id || null;

    const wallet = await WalletService.createWallet(req.body, scope.tenantId, userId);
    return sendSuccess(res, 201, "Wallet created successfully.", wallet, requestId);
  } catch (error) {
    console.error("createWallet error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to create wallet.", requestId);
  }
};

export const listWallets = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.wallet.read", "finance.read")) return sendError(res, 403, "Permission denied.", requestId);

    const wallets = await WalletService.listWallets(req.query, scope.tenantId);
    return sendSuccess(res, 200, "Wallets retrieved successfully.", { items: wallets }, requestId);
  } catch (error) {
    console.error("listWallets error:", error);
    return sendError(res, 500, error.message || "Failed to retrieve wallets.", requestId);
  }
};

export const getWallet = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.wallet.read", "finance.read")) return sendError(res, 403, "Permission denied.", requestId);

    const wallet = await WalletService.getWalletById(req.params.walletId, scope.tenantId);
    return sendSuccess(res, 200, "Wallet retrieved successfully.", wallet.toJSON ? wallet.toJSON() : wallet, requestId);
  } catch (error) {
    console.error("getWallet error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to retrieve wallet.", requestId);
  }
};

export const listWalletTransactions = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.wallet.read", "finance.read")) return sendError(res, 403, "Permission denied.", requestId);

    const items = await WalletService.listTransactions(req.params.walletId, scope.tenantId, req.query);
    return sendSuccess(res, 200, "Wallet transactions retrieved successfully.", { items }, requestId);
  } catch (error) {
    console.error("listWalletTransactions error:", error);
    return sendError(res, 500, error.message || "Failed to retrieve wallet transactions.", requestId);
  }
};

export const topUpWallet = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.wallet.manage")) return sendError(res, 403, "Permission denied.", requestId);
    const userId = req.auth?.userId || req.auth?.id || null;

    const result = await WalletService.topUp(req.params.walletId, req.body, scope.tenantId, userId);
    return sendSuccess(res, result.payment?.status === "Failed" ? 402 : 201, "Wallet top-up processed.", result, requestId);
  } catch (error) {
    console.error("topUpWallet error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to top up wallet.", requestId);
  }
};

export const purchaseWithWallet = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.wallet.manage")) return sendError(res, 403, "Permission denied.", requestId);
    const userId = req.auth?.userId || req.auth?.id || null;

    const result = await WalletService.purchase(req.params.walletId, req.body, scope.tenantId, userId);
    return sendSuccess(res, result.collection?.paymentStatus === "Failed" ? 402 : 200, "Wallet purchase processed.", result, requestId);
  } catch (error) {
    console.error("purchaseWithWallet error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to process wallet purchase.", requestId);
  }
};

export const refundToWallet = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.wallet.manage")) return sendError(res, 403, "Permission denied.", requestId);
    const userId = req.auth?.userId || req.auth?.id || null;

    const result = await WalletService.refund(req.params.walletId, req.body, scope.tenantId, userId);
    return sendSuccess(res, 200, "Wallet refunded successfully.", result, requestId);
  } catch (error) {
    console.error("refundToWallet error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to refund to wallet.", requestId);
  }
};

export const transferWallet = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.wallet.manage")) return sendError(res, 403, "Permission denied.", requestId);
    const userId = req.auth?.userId || req.auth?.id || null;

    const result = await WalletService.transfer(req.params.walletId, req.body, scope.tenantId, userId);
    return sendSuccess(res, 200, "Wallet transfer processed.", result, requestId);
  } catch (error) {
    console.error("transferWallet error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to transfer wallet balance.", requestId);
  }
};

export const withdrawWallet = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.wallet.manage")) return sendError(res, 403, "Permission denied.", requestId);
    const userId = req.auth?.userId || req.auth?.id || null;

    const result = await WalletService.withdraw(req.params.walletId, req.body, scope.tenantId, userId);
    return sendSuccess(res, 200, "Wallet withdrawal processed.", result, requestId);
  } catch (error) {
    console.error("withdrawWallet error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to process wallet withdrawal.", requestId);
  }
};

export const suspendWallet = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.wallet.manage")) return sendError(res, 403, "Permission denied.", requestId);
    const userId = req.auth?.userId || req.auth?.id || null;

    const wallet = await WalletService.suspend(req.params.walletId, req.body, scope.tenantId, userId);
    return sendSuccess(res, 200, "Wallet suspended successfully.", wallet, requestId);
  } catch (error) {
    console.error("suspendWallet error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to suspend wallet.", requestId);
  }
};

export const reactivateWallet = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.wallet.manage")) return sendError(res, 403, "Permission denied.", requestId);
    const userId = req.auth?.userId || req.auth?.id || null;

    const wallet = await WalletService.reactivate(req.params.walletId, scope.tenantId, userId);
    return sendSuccess(res, 200, "Wallet reactivated successfully.", wallet, requestId);
  } catch (error) {
    console.error("reactivateWallet error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to reactivate wallet.", requestId);
  }
};

export const closeWallet = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.wallet.manage")) return sendError(res, 403, "Permission denied.", requestId);
    const userId = req.auth?.userId || req.auth?.id || null;

    const wallet = await WalletService.close(req.params.walletId, scope.tenantId, userId);
    return sendSuccess(res, 200, "Wallet closed successfully.", wallet, requestId);
  } catch (error) {
    console.error("closeWallet error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to close wallet.", requestId);
  }
};
