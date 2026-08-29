import crypto from "crypto";
import VendorModel from "../models/VendorModel.js";
import VendorPortalTokenModel from "../models/VendorPortalTokenModel.js";
import VendorInvoiceModel from "../models/VendorInvoiceModel.js";
import AuditLogModel from "../models/AuditLogmodel.js";
import VendorPaymentService from "../services/VendorPaymentService.js";
import { hashToken, createRequestId } from "../utils/authTokens.js";
import { sendSuccess, sendError } from "../utils/apiResponse.js";
import { getAccessScope, getVendorAccessScope } from "../utils/accessScope.js";
import { publishEvent } from "../utils/eventBus.js";

// Supplier Self-Service Portal (PRD "CRM Feature Map by Phase" Phase 3
// module 24). Two halves in this one file, same split as
// AgentPortalController.js: staff-side (req.auth, tenant-wide) issues/
// revokes a supplier's portal credential; supplier-side (req.vendorAuth,
// scoped to exactly one vendor via getVendorAccessScope) is everything the
// supplier itself can reach with that credential.
const hasPermission = (req, ...keys) => {
  const permissions = req.auth?.permissions || [];
  return permissions.includes("admin") || keys.some((key) => permissions.includes(key));
};

const generateRawKey = () => `svt_${crypto.randomBytes(24).toString("hex")}`;

// ---- Staff-side: issue/revoke a supplier's own portal credential ----

export const issueSupplierPortalToken = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.vendorportal.manage")) return sendError(res, 403, "Permission denied.", requestId);

    const vendor = await VendorModel.findOne({ _id: req.params.vendorId, tenantId: scope.tenantId }).lean();
    if (!vendor) return sendError(res, 404, "Vendor not found.", requestId);

    const { name = null, expiresAt = null } = req.body || {};
    const rawKey = generateRawKey();
    const token = await VendorPortalTokenModel.create({
      tenantId: scope.tenantId,
      vendorId: vendor._id,
      name,
      keyPrefix: rawKey.slice(0, 12),
      hashedKey: hashToken(rawKey),
      expiresAt: expiresAt ? new Date(expiresAt) : null,
      createdBy: req.auth?.id || req.auth?.userId || null
    });

    await AuditLogModel.create({ action: "supplierportal.token.issue", module: "SupplierPortal", resource: "VendorPortalToken", resourceId: token._id.toString(), userId: req.auth?.id || null, tenantId: scope.tenantId, details: { vendorId: vendor._id.toString(), keyPrefix: token.keyPrefix } });
    publishEvent("SupplierPortalTokenIssued", { tenantId: scope.tenantId, vendorId: vendor._id.toString(), tokenId: token._id.toString(), performedBy: req.auth?.id || null });

    // The ONLY time the raw token is ever returned — hand it to the supplier out of band; it cannot be recovered after this response.
    return sendSuccess(res, 201, "Supplier portal token issued successfully. This token will not be shown again — share it securely with the supplier.", { ...token.toJSON(), token: rawKey }, requestId);
  } catch (error) {
    console.error("issueSupplierPortalToken error:", error);
    return sendError(res, 500, error.message || "Failed to issue supplier portal token.", requestId);
  }
};

export const listSupplierPortalTokens = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.vendorportal.manage")) return sendError(res, 403, "Permission denied.", requestId);

    const items = await VendorPortalTokenModel.find({ tenantId: scope.tenantId, vendorId: req.params.vendorId }).select("-hashedKey").sort({ createdAt: -1 }).lean();
    return sendSuccess(res, 200, "Supplier portal tokens retrieved successfully.", { items }, requestId);
  } catch (error) {
    console.error("listSupplierPortalTokens error:", error);
    return sendError(res, 500, error.message || "Failed to retrieve supplier portal tokens.", requestId);
  }
};

export const revokeSupplierPortalToken = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.vendorportal.manage")) return sendError(res, 403, "Permission denied.", requestId);

    const token = await VendorPortalTokenModel.findOne({ _id: req.params.tokenId, tenantId: scope.tenantId });
    if (!token) return sendError(res, 404, "Supplier portal token not found.", requestId);
    if (token.status === "Revoked") return sendError(res, 409, "Supplier portal token is already revoked.", requestId);

    token.status = "Revoked";
    token.revokedBy = req.auth?.id || req.auth?.userId || null;
    token.revokedAt = new Date();
    await token.save();

    await AuditLogModel.create({ action: "supplierportal.token.revoke", module: "SupplierPortal", resource: "VendorPortalToken", resourceId: token._id.toString(), userId: req.auth?.id || null, tenantId: scope.tenantId, details: {} });
    publishEvent("SupplierPortalTokenRevoked", { tenantId: scope.tenantId, tokenId: token._id.toString(), performedBy: req.auth?.id || null });

    return sendSuccess(res, 200, "Supplier portal token revoked successfully.", token.toJSON(), requestId);
  } catch (error) {
    console.error("revokeSupplierPortalToken error:", error);
    return sendError(res, 500, error.message || "Failed to revoke supplier portal token.", requestId);
  }
};

// ---- Supplier-side: reached only with a valid X-Supplier-Token, own vendor's data only ----

export const getMySupplierProfile = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getVendorAccessScope(req);
    if (!scope) return sendError(res, 403, "Supplier portal context is required.", requestId);

    const vendor = await VendorModel.findOne({ _id: scope.vendorId, tenantId: scope.tenantId }).select("name contactPerson contactEmail contactPhone status").lean();
    if (!vendor) return sendError(res, 404, "Vendor not found.", requestId);

    return sendSuccess(res, 200, "Supplier profile retrieved successfully.", vendor, requestId);
  } catch (error) {
    console.error("getMySupplierProfile error:", error);
    return sendError(res, 500, error.message || "Failed to retrieve supplier profile.", requestId);
  }
};

export const submitSupplierInvoice = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getVendorAccessScope(req);
    if (!scope) return sendError(res, 403, "Supplier portal context is required.", requestId);

    const { supplierInvoiceNumber, amount, currency, description = null, attachments = [] } = req.body || {};
    if (!supplierInvoiceNumber || !amount || !currency) {
      return sendError(res, 400, "supplierInvoiceNumber, amount, and currency are required.", requestId);
    }

    const invoice = await VendorInvoiceModel.create({
      tenantId: scope.tenantId, vendorId: scope.vendorId, supplierInvoiceNumber,
      amount, currency: currency.toUpperCase(), description, attachments: Array.isArray(attachments) ? attachments : []
    });

    await AuditLogModel.create({ action: "supplierportal.invoice.submit", module: "SupplierPortal", resource: "VendorInvoice", resourceId: invoice._id.toString(), userId: null, tenantId: scope.tenantId, details: { vendorId: scope.vendorId, supplierInvoiceNumber } });
    publishEvent("SupplierInvoiceSubmitted", { tenantId: scope.tenantId, vendorId: scope.vendorId, invoiceId: invoice._id.toString() });

    return sendSuccess(res, 201, "Invoice submitted for review successfully.", invoice.toJSON(), requestId);
  } catch (error) {
    console.error("submitSupplierInvoice error:", error);
    return sendError(res, 500, error.message || "Failed to submit invoice.", requestId);
  }
};

export const listMySupplierInvoices = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getVendorAccessScope(req);
    if (!scope) return sendError(res, 403, "Supplier portal context is required.", requestId);

    const items = await VendorInvoiceModel.find({ tenantId: scope.tenantId, vendorId: scope.vendorId }).sort({ createdAt: -1 }).lean();
    return sendSuccess(res, 200, "Invoices retrieved successfully.", { items }, requestId);
  } catch (error) {
    console.error("listMySupplierInvoices error:", error);
    return sendError(res, 500, error.message || "Failed to retrieve invoices.", requestId);
  }
};

export const listMySupplierPayments = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getVendorAccessScope(req);
    if (!scope) return sendError(res, 403, "Supplier portal context is required.", requestId);

    // Reuses the exact same VendorPaymentService a staff member's own
    // GET /vendor-payments call goes through — a supplier only ever gets
    // vendorId force-set to their own, never a caller-suppliable filter.
    const result = await VendorPaymentService.listVendorPayments({ ...req.query, vendorId: scope.vendorId }, scope.tenantId);
    return sendSuccess(res, 200, "Payments retrieved successfully.", result, requestId);
  } catch (error) {
    console.error("listMySupplierPayments error:", error);
    return sendError(res, 500, error.message || "Failed to retrieve payments.", requestId);
  }
};
