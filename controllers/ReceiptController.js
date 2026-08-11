import ReceiptService from "../services/ReceiptService.js";
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
  if (message.includes("required") || message.includes("cannot") || message.includes("has not been verified")) return 400;
  return 500;
};

export const listReceipts = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.receipt.read", "finance.read")) return sendError(res, 403, "Permission denied.", requestId);

    const result = await ReceiptService.listReceipts(req.query, scope.tenantId);
    return sendSuccess(res, 200, "Receipts retrieved successfully.", result, requestId);
  } catch (error) {
    console.error("listReceipts error:", error);
    return sendError(res, 500, error.message || "Failed to retrieve receipts.", requestId);
  }
};

export const getReceipt = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.receipt.read", "finance.read")) return sendError(res, 403, "Permission denied.", requestId);

    const receipt = await ReceiptService.getReceiptById(req.params.receiptId, scope.tenantId);
    return sendSuccess(res, 200, "Receipt retrieved successfully.", receipt, requestId);
  } catch (error) {
    console.error("getReceipt error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to retrieve receipt.", requestId);
  }
};

export const createReceipt = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.receipt.create")) return sendError(res, 403, "Permission denied.", requestId);
    const userId = req.auth?.userId || req.auth?.id || null;

    const receipt = await ReceiptService.createReceipt(req.body, scope.tenantId, userId);
    return sendSuccess(res, 201, "Receipt generated successfully.", receipt, requestId);
  } catch (error) {
    console.error("createReceipt error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to generate receipt.", requestId);
  }
};

export const reissueReceipt = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.receipt.reissue")) return sendError(res, 403, "Permission denied.", requestId);
    const userId = req.auth?.userId || req.auth?.id || null;

    const result = await ReceiptService.reissue(req.params.receiptId, req.body, scope.tenantId, userId);
    return sendSuccess(res, 201, "Receipt reissued successfully.", result, requestId);
  } catch (error) {
    console.error("reissueReceipt error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to reissue receipt.", requestId);
  }
};

export const cancelReceipt = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.receipt.cancel")) return sendError(res, 403, "Permission denied.", requestId);
    const userId = req.auth?.userId || req.auth?.id || null;

    const receipt = await ReceiptService.cancel(req.params.receiptId, req.body, scope.tenantId, userId);
    return sendSuccess(res, 200, "Receipt cancelled successfully.", receipt, requestId);
  } catch (error) {
    console.error("cancelReceipt error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to cancel receipt.", requestId);
  }
};

export const redeliverReceipt = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.receipt.create")) return sendError(res, 403, "Permission denied.", requestId);
    const userId = req.auth?.userId || req.auth?.id || null;

    const receipt = await ReceiptService.redeliver(req.params.receiptId, req.body, scope.tenantId, userId);
    return sendSuccess(res, 200, "Receipt redelivery attempted.", receipt, requestId);
  } catch (error) {
    console.error("redeliverReceipt error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to redeliver receipt.", requestId);
  }
};

/**
 * GET /api/v1/receipts/verify/:token — DELIBERATELY PUBLIC, no
 * authenticateAccessToken. "QR Code -> Public Verification API -> Receipt
 * Valid -> Payment Verified. Supports fraud prevention" is an explicit spec
 * requirement: whoever is shown a receipt (a customer, a third party, an
 * auditor) must be able to verify it without an ERP login. Access control
 * is the token itself (24 random bytes, effectively unguessable) rather
 * than authentication — the same "capability URL" pattern used for things
 * like shipment tracking or e-ticket verification. The response is
 * deliberately minimal (no customer name, no internal ids beyond the
 * receipt number) precisely because this route has no auth gate.
 */
export const verifyReceipt = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const result = await ReceiptService.verifyByToken(req.params.token);
    return sendSuccess(res, result.valid === false ? 404 : 200, result.valid === false ? "Receipt not found or invalid." : "Receipt verified.", result, requestId);
  } catch (error) {
    console.error("verifyReceipt error:", error);
    return sendError(res, 500, "Failed to verify receipt.", requestId);
  }
};

/**
 * GET /api/v1/receipts/download/:token — DELIBERATELY PUBLIC, same
 * token-gated reasoning as verifyReceipt above (a customer who received a
 * receipt link by email/WhatsApp has no ERP login to present).
 */
export const downloadReceiptPdf = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const url = await ReceiptService.getPdfUrlByToken(req.params.token);
    return res.redirect(url);
  } catch (error) {
    console.error("downloadReceiptPdf error:", error);
    return sendError(res, error.message?.includes("not found") ? 404 : 500, error.message || "Failed to retrieve receipt PDF.", requestId);
  }
};
