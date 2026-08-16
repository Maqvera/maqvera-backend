import VendorService from "../services/VendorService.js";
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

/**
 * Minimal Vendor endpoints (see models/VendorModel.js) — just enough to
 * create/read a vendor so Accounts Payable has something real to owe money
 * to. Vendor conceptually belongs to a future Purchasing/Procurement
 * module; Finance references it, doesn't own it (Part 1 boundary).
 */
export const listVendors = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.vendor.read", "finance.read")) return sendError(res, 403, "Permission denied.", requestId);

    const result = await VendorService.listVendors(req.query, scope.tenantId);
    return sendSuccess(res, 200, "Vendors retrieved successfully.", result, requestId);
  } catch (error) {
    console.error("listVendors error:", error);
    return sendError(res, 500, error.message || "Failed to retrieve vendors.", requestId);
  }
};

export const getVendor = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.vendor.read", "finance.read")) return sendError(res, 403, "Permission denied.", requestId);

    const vendor = await VendorService.getVendorById(req.params.vendorId, scope.tenantId);
    return sendSuccess(res, 200, "Vendor retrieved successfully.", vendor, requestId);
  } catch (error) {
    console.error("getVendor error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to retrieve vendor.", requestId);
  }
};

export const createVendor = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.vendor.create")) return sendError(res, 403, "Permission denied.", requestId);
    const userId = req.auth?.userId || req.auth?.id || null;

    const vendor = await VendorService.createVendor(req.body, scope.tenantId, userId);
    return sendSuccess(res, 201, "Vendor created successfully.", vendor, requestId);
  } catch (error) {
    console.error("createVendor error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to create vendor.", requestId);
  }
};
