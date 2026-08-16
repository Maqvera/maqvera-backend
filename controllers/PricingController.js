import PricingService from "../services/PricingService.js";
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
  if (message.includes("required") || message.includes("cannot") || message.includes("Cannot") || message.includes("Invalid") || message.includes("must be") || message.includes("No price found") || message.includes("cannot be applied")) return 400;
  return 500;
};

// ---- Pricing Rules ----

export const createPricingRule = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.pricing.manage")) return sendError(res, 403, "Permission denied.", requestId);
    const userId = req.auth?.userId || req.auth?.id || null;

    const rule = await PricingService.createPricingRule(req.body, scope.tenantId, userId);
    return sendSuccess(res, 201, "Pricing rule created successfully.", rule, requestId);
  } catch (error) {
    console.error("createPricingRule error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to create pricing rule.", requestId);
  }
};

export const listPricingRules = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.pricing.read", "finance.read")) return sendError(res, 403, "Permission denied.", requestId);

    const result = await PricingService.listPricingRules(req.query, scope.tenantId);
    return sendSuccess(res, 200, "Pricing rules retrieved successfully.", result, requestId);
  } catch (error) {
    console.error("listPricingRules error:", error);
    return sendError(res, 500, error.message || "Failed to retrieve pricing rules.", requestId);
  }
};

export const getPricingRule = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.pricing.read", "finance.read")) return sendError(res, 403, "Permission denied.", requestId);

    const rule = await PricingService.getPricingRuleById(req.params.ruleId, scope.tenantId);
    return sendSuccess(res, 200, "Pricing rule retrieved successfully.", rule, requestId);
  } catch (error) {
    console.error("getPricingRule error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to retrieve pricing rule.", requestId);
  }
};

export const approvePricingRule = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.pricing.approve")) return sendError(res, 403, "Permission denied.", requestId);
    const userId = req.auth?.userId || req.auth?.id || null;

    const rule = await PricingService.approvePricingRule(req.params.ruleId, scope.tenantId, userId);
    return sendSuccess(res, 200, "Pricing rule approved successfully.", rule, requestId);
  } catch (error) {
    console.error("approvePricingRule error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to approve pricing rule.", requestId);
  }
};

export const archivePricingRule = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.pricing.manage")) return sendError(res, 403, "Permission denied.", requestId);
    const userId = req.auth?.userId || req.auth?.id || null;

    const rule = await PricingService.archivePricingRule(req.params.ruleId, scope.tenantId, userId);
    return sendSuccess(res, 200, "Pricing rule archived successfully.", rule, requestId);
  } catch (error) {
    console.error("archivePricingRule error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to archive pricing rule.", requestId);
  }
};

// ---- Pricing Calculation ----

export const calculatePrice = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.pricing.read", "finance.read")) return sendError(res, 403, "Permission denied.", requestId);
    const userId = req.auth?.userId || req.auth?.id || null;

    const result = await PricingService.calculatePrice(req.body, scope.tenantId, userId);
    return sendSuccess(res, 201, "Price calculated successfully.", result, requestId);
  } catch (error) {
    console.error("calculatePrice error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to calculate price.", requestId);
  }
};

// ---- Price Lists ----

export const createPriceList = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.pricing.manage")) return sendError(res, 403, "Permission denied.", requestId);
    const userId = req.auth?.userId || req.auth?.id || null;

    const priceList = await PricingService.createPriceList(req.body, scope.tenantId, userId);
    return sendSuccess(res, 201, "Price list created successfully.", priceList, requestId);
  } catch (error) {
    console.error("createPriceList error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to create price list.", requestId);
  }
};

export const listPriceLists = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.pricing.read", "finance.read")) return sendError(res, 403, "Permission denied.", requestId);

    const items = await PricingService.listPriceLists(req.query, scope.tenantId);
    return sendSuccess(res, 200, "Price lists retrieved successfully.", { items }, requestId);
  } catch (error) {
    console.error("listPriceLists error:", error);
    return sendError(res, 500, error.message || "Failed to retrieve price lists.", requestId);
  }
};

export const upsertPriceListEntry = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.pricing.manage")) return sendError(res, 403, "Permission denied.", requestId);
    const userId = req.auth?.userId || req.auth?.id || null;

    const entry = await PricingService.upsertPriceListEntry(req.params.priceListId, req.body, scope.tenantId, userId);
    return sendSuccess(res, 200, "Price list entry saved successfully.", entry, requestId);
  } catch (error) {
    console.error("upsertPriceListEntry error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to save price list entry.", requestId);
  }
};

export const listPriceListEntries = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.pricing.read", "finance.read")) return sendError(res, 403, "Permission denied.", requestId);

    const items = await PricingService.listPriceListEntries(req.params.priceListId, scope.tenantId);
    return sendSuccess(res, 200, "Price list entries retrieved successfully.", { items }, requestId);
  } catch (error) {
    console.error("listPriceListEntries error:", error);
    return sendError(res, 500, error.message || "Failed to retrieve price list entries.", requestId);
  }
};

// ---- Coupons ----

export const createCoupon = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.pricing.manage")) return sendError(res, 403, "Permission denied.", requestId);
    const userId = req.auth?.userId || req.auth?.id || null;

    const coupon = await PricingService.createCoupon(req.body, scope.tenantId, userId);
    return sendSuccess(res, 201, "Coupon created successfully.", coupon, requestId);
  } catch (error) {
    console.error("createCoupon error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to create coupon.", requestId);
  }
};

export const listCoupons = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.pricing.read", "finance.read")) return sendError(res, 403, "Permission denied.", requestId);

    const items = await PricingService.listCoupons(req.query, scope.tenantId);
    return sendSuccess(res, 200, "Coupons retrieved successfully.", { items }, requestId);
  } catch (error) {
    console.error("listCoupons error:", error);
    return sendError(res, 500, error.message || "Failed to retrieve coupons.", requestId);
  }
};

export const revokeCoupon = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.pricing.manage")) return sendError(res, 403, "Permission denied.", requestId);
    const userId = req.auth?.userId || req.auth?.id || null;

    const coupon = await PricingService.revokeCoupon(req.params.couponId, req.body, scope.tenantId, userId);
    return sendSuccess(res, 200, "Coupon revoked successfully.", coupon, requestId);
  } catch (error) {
    console.error("revokeCoupon error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to revoke coupon.", requestId);
  }
};
