import MerchantAccountService from "../services/MerchantAccountService.js";
import TenantSubscriptionService from "../services/TenantSubscriptionService.js";
import MerchantAccountModel from "../models/MerchantAccountModel.js";
import MerchantWalletModel from "../models/MerchantWalletModel.js";
import TenantBillingAccountModel from "../models/TenantBillingAccountModel.js";
import SubscriptionInvoiceModel from "../models/SubscriptionInvoiceModel.js";
import { sendSuccess, sendError } from "../utils/apiResponse.js";
import { createRequestId } from "../utils/authTokens.js";
import { getAccessScope } from "../utils/accessScope.js";
import { getPlatformConfig } from "../utils/platformConfig.js";
import { publishEvent } from "../utils/eventBus.js";

const hasPermission = (req, ...keys) => {
  const permissions = req.auth?.permissions || [];
  return permissions.includes("admin") || keys.some((key) => permissions.includes(key));
};

const statusFromError = (error) => {
  const message = error.message || "";
  if (message.includes("already") || message.includes("Insufficient")) return 409;
  if (message.includes("not found")) return 404;
  if (message.includes("required") || message.includes("Invalid") || message.includes("Cannot") || message.includes("cannot") || message.includes("No billable")) return 400;
  return 500;
};

// ---- Merchants ----
// Reuses the existing tenant-scoped "admin" permission — no separate
// Platform Operator identity exists in this codebase's auth model (same
// reasoning already recorded in Improvement 1/File 0). A merchant is not
// itself owned by any one tenant, but every call here still requires a
// real authenticated tenant context (getAccessScope) — there is no
// unauthenticated path onto this router.

export const createMerchant = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "platform.merchant.manage")) return sendError(res, 403, "Permission denied.", requestId);
    const userId = req.auth?.userId || req.auth?.id || null;

    const merchant = await MerchantAccountService.createMerchant(req.body, userId);
    return sendSuccess(res, 201, "Merchant created successfully.", merchant, requestId);
  } catch (error) {
    console.error("createMerchant error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to create merchant.", requestId);
  }
};

export const listMerchants = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "platform.merchant.read")) return sendError(res, 403, "Permission denied.", requestId);

    const result = await MerchantAccountService.listMerchants(req.query);
    return sendSuccess(res, 200, "Merchants retrieved successfully.", result, requestId);
  } catch (error) {
    console.error("listMerchants error:", error);
    return sendError(res, 500, error.message || "Failed to retrieve merchants.", requestId);
  }
};

export const getMerchant = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "platform.merchant.read")) return sendError(res, 403, "Permission denied.", requestId);

    const merchant = await MerchantAccountService.getMerchantById(req.params.merchantId);
    return sendSuccess(res, 200, "Merchant retrieved successfully.", merchant, requestId);
  } catch (error) {
    console.error("getMerchant error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to retrieve merchant.", requestId);
  }
};

export const verifyMerchant = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "platform.merchant.manage")) return sendError(res, 403, "Permission denied.", requestId);
    const userId = req.auth?.userId || req.auth?.id || null;

    const merchant = await MerchantAccountService.verifyMerchant(req.params.merchantId, userId);
    return sendSuccess(res, 200, "Merchant verified successfully.", merchant, requestId);
  } catch (error) {
    console.error("verifyMerchant error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to verify merchant.", requestId);
  }
};

/** Links the CALLER's own tenant to a merchant — a tenant can only ever add itself, never an arbitrary tenantId, same cross-tenant-safety discipline as every other endpoint in this platform. */
export const joinMerchant = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "platform.merchant.manage")) return sendError(res, 403, "Permission denied.", requestId);
    const userId = req.auth?.userId || req.auth?.id || null;

    const merchant = await MerchantAccountService.addTenantToMerchant(req.params.merchantId, scope.tenantId, userId);
    return sendSuccess(res, 200, "Tenant added to merchant successfully.", merchant, requestId);
  } catch (error) {
    console.error("joinMerchant error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to add tenant to merchant.", requestId);
  }
};

const assertOwnMerchant = async (req, scope, merchantIdOverride = null) => {
  const merchantId = merchantIdOverride || req.params.merchantId;
  const merchant = await MerchantAccountModel.findOne({ _id: merchantId }).lean();
  if (!merchant) throw Object.assign(new Error("Merchant not found."), { httpStatus: 404 });
  if (!merchant.tenantIds.includes(scope.tenantId)) throw Object.assign(new Error("Merchant not found."), { httpStatus: 404 });
  return merchant;
};

export const suspendMerchant = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "admin")) return sendError(res, 403, "Permission denied.", requestId);
    const userId = req.auth?.userId || req.auth?.id || null;

    await assertOwnMerchant(req, scope);
    const result = await MerchantAccountService.suspendMerchant(req.params.merchantId, req.body.reason, userId);
    return sendSuccess(res, 200, "Merchant suspended successfully.", result, requestId);
  } catch (error) {
    console.error("suspendMerchant error:", error);
    return sendError(res, error.httpStatus || statusFromError(error), error.message || "Failed to suspend merchant.", requestId);
  }
};

export const reactivateMerchant = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "admin")) return sendError(res, 403, "Permission denied.", requestId);
    const userId = req.auth?.userId || req.auth?.id || null;

    await assertOwnMerchant(req, scope);
    const result = await MerchantAccountService.reactivateMerchant(req.params.merchantId, userId);
    return sendSuccess(res, 200, "Merchant reactivated successfully.", result, requestId);
  } catch (error) {
    console.error("reactivateMerchant error:", error);
    return sendError(res, error.httpStatus || statusFromError(error), error.message || "Failed to reactivate merchant.", requestId);
  }
};

// ---- Billing Accounts ----
// GET/POST /api/v1/billing-accounts — File 0 already built the real,
// tested self-service `/api/v1/platform/billing-account` (singular, the
// caller's own tenant). These are the spec's own literal resource-style
// paths for the same real underlying TenantSubscriptionService methods —
// reused, not duplicated.

export const listBillingAccounts = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "platform.billing.read")) return sendError(res, 403, "Permission denied.", requestId);

    const account = await TenantBillingAccountModel.findOne({ tenantId: scope.tenantId }).lean();
    return sendSuccess(res, 200, "Billing accounts retrieved successfully.", { items: account ? [account] : [] }, requestId);
  } catch (error) {
    console.error("listBillingAccounts error:", error);
    return sendError(res, 500, error.message || "Failed to retrieve billing accounts.", requestId);
  }
};

export const createBillingAccountResource = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "platform.billing.manage")) return sendError(res, 403, "Permission denied.", requestId);
    const userId = req.auth?.userId || req.auth?.id || null;

    const account = await TenantSubscriptionService.setupBillingAccount(scope.tenantId, req.body, userId);
    return sendSuccess(res, 201, "Billing account created successfully.", account, requestId);
  } catch (error) {
    console.error("createBillingAccountResource error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to create billing account.", requestId);
  }
};

// ---- Billing Invoices ----

/** POST /api/v1/billing-invoices — the real consolidation endpoint: one invoice covering every member tenant sharing the caller's own billing account. */
export const createBillingInvoice = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "platform.billing.manage")) return sendError(res, 403, "Permission denied.", requestId);
    const userId = req.auth?.userId || req.auth?.id || null;

    const account = await TenantBillingAccountModel.findOne({ tenantId: scope.tenantId }).lean();
    if (!account) return sendError(res, 404, "Billing account not found.", requestId);

    const result = await TenantSubscriptionService.generateConsolidatedInvoice(account._id, userId);
    return sendSuccess(res, 201, "Billing invoice generated successfully.", result, requestId);
  } catch (error) {
    console.error("createBillingInvoice error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to generate billing invoice.", requestId);
  }
};

// ---- Payment Methods ----

/** POST /api/v1/payment-methods — attaches/updates the caller's own billing account's payment method. */
export const addPaymentMethod = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "platform.billing.manage")) return sendError(res, 403, "Permission denied.", requestId);
    const userId = req.auth?.userId || req.auth?.id || null;
    const config = getPlatformConfig();

    const { paymentMethod } = req.body;
    if (!config.billingPaymentMethods.includes(paymentMethod)) return sendError(res, 400, `Invalid paymentMethod "${paymentMethod}".`, requestId);

    const existing = await TenantBillingAccountModel.findOne({ tenantId: scope.tenantId }).lean();
    const account = await TenantSubscriptionService.setupBillingAccount(scope.tenantId, { ...(existing || {}), ...req.body }, userId);
    publishEvent("PaymentMethodAdded", { tenantId: scope.tenantId, paymentMethod, performedBy: userId });

    return sendSuccess(res, 200, "Payment method saved successfully.", account, requestId);
  } catch (error) {
    console.error("addPaymentMethod error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to save payment method.", requestId);
  }
};

// ---- Merchant Wallet ----

export const createOrGetWallet = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "platform.merchant.manage")) return sendError(res, 403, "Permission denied.", requestId);
    const userId = req.auth?.userId || req.auth?.id || null;

    const { merchantId, balanceType = "Credit", amount, currency } = req.body;
    await assertOwnMerchant(req, scope, merchantId);
    const wallet = amount
      ? await MerchantAccountService.creditWallet(merchantId, { balanceType, amount, currency, userId })
      : await MerchantAccountService.getWallet(merchantId);
    return sendSuccess(res, 201, "Wallet operation completed successfully.", wallet, requestId);
  } catch (error) {
    console.error("createOrGetWallet error:", error);
    return sendError(res, error.httpStatus || statusFromError(error), error.message || "Failed to process wallet operation.", requestId);
  }
};

export const getWallet = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "platform.merchant.read")) return sendError(res, 403, "Permission denied.", requestId);

    await assertOwnMerchant(req, scope, req.params.merchantId);
    const wallet = await MerchantAccountService.getWallet(req.params.merchantId);
    return sendSuccess(res, 200, "Wallet retrieved successfully.", wallet, requestId);
  } catch (error) {
    console.error("getWallet error:", error);
    return sendError(res, error.httpStatus || statusFromError(error), error.message || "Failed to retrieve wallet.", requestId);
  }
};

/** POST /api/v1/merchant/refund */
export const refundToMerchantWallet = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "platform.merchant.manage")) return sendError(res, 403, "Permission denied.", requestId);
    const userId = req.auth?.userId || req.auth?.id || null;

    const { merchantId, amount, currency, reason, referenceId } = req.body;
    await assertOwnMerchant(req, scope, merchantId);
    const wallet = await MerchantAccountService.refundToWallet(merchantId, { amount, currency, reason, referenceId, userId });
    return sendSuccess(res, 201, "Refund credited to merchant wallet successfully.", wallet, requestId);
  } catch (error) {
    console.error("refundToMerchantWallet error:", error);
    return sendError(res, error.httpStatus || statusFromError(error), error.message || "Failed to process refund.", requestId);
  }
};

// ---- Billing History ----

/** GET /api/v1/billing-history — real aggregate of the caller's own tenant's subscription invoices + (if merchant-linked) wallet transactions. */
export const getBillingHistory = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "platform.billing.read")) return sendError(res, 403, "Permission denied.", requestId);

    const [ownInvoices, billingAccount] = await Promise.all([
      SubscriptionInvoiceModel.find({ $or: [{ tenantId: scope.tenantId }, { tenantIds: scope.tenantId }] }).sort({ createdAt: -1 }).lean(),
      TenantBillingAccountModel.findOne({ tenantId: scope.tenantId }).lean()
    ]);

    let walletTransactions = [];
    if (billingAccount?.merchantAccountId) {
      const wallet = await MerchantWalletModel.findOne({ merchantAccountId: billingAccount.merchantAccountId }).lean();
      walletTransactions = wallet?.transactions || [];
    }

    return sendSuccess(res, 200, "Billing history retrieved successfully.", { invoices: ownInvoices, walletTransactions }, requestId);
  } catch (error) {
    console.error("getBillingHistory error:", error);
    return sendError(res, 500, error.message || "Failed to retrieve billing history.", requestId);
  }
};
