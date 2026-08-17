import InvoiceService from "../services/InvoiceService.js";
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
  if (message.includes("required") || message.includes("cannot") || message.includes("Unknown taxCode") || message.includes("must be") || message.includes("Only Draft")) return 400;
  return 500;
};

export const listInvoices = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.invoice.read", "finance.read")) return sendError(res, 403, "Permission denied.", requestId);

    const result = await InvoiceService.listInvoices(req.query, scope.tenantId);
    return sendSuccess(res, 200, "Invoices retrieved successfully.", result, requestId);
  } catch (error) {
    console.error("listInvoices error:", error);
    return sendError(res, 500, error.message || "Failed to retrieve invoices.", requestId);
  }
};

export const getInvoice = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.invoice.read", "finance.read")) return sendError(res, 403, "Permission denied.", requestId);

    const invoice = await InvoiceService.getInvoiceById(req.params.invoiceId, scope.tenantId);
    return sendSuccess(res, 200, "Invoice retrieved successfully.", invoice, requestId);
  } catch (error) {
    console.error("getInvoice error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to retrieve invoice.", requestId);
  }
};

export const createInvoice = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.invoice.create")) return sendError(res, 403, "Permission denied.", requestId);
    const userId = req.auth?.userId || req.auth?.id || null;

    const invoice = await InvoiceService.createInvoice(req.body, scope.tenantId, userId);
    return sendSuccess(res, 201, "Invoice created successfully.", invoice, requestId);
  } catch (error) {
    console.error("createInvoice error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to create invoice.", requestId);
  }
};

export const updateInvoice = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.invoice.update")) return sendError(res, 403, "Permission denied.", requestId);
    const userId = req.auth?.userId || req.auth?.id || null;

    const invoice = await InvoiceService.updateInvoice(req.params.invoiceId, req.body, scope.tenantId, userId);
    return sendSuccess(res, 200, "Invoice updated successfully.", invoice, requestId);
  } catch (error) {
    console.error("updateInvoice error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to update invoice.", requestId);
  }
};

export const approveInvoice = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.invoice.approve")) return sendError(res, 403, "Permission denied.", requestId);
    const userId = req.auth?.userId || req.auth?.id || null;

    const invoice = await InvoiceService.approveInvoice(req.params.invoiceId, scope.tenantId, userId);
    return sendSuccess(res, 200, "Invoice approved successfully.", invoice, requestId);
  } catch (error) {
    console.error("approveInvoice error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to approve invoice.", requestId);
  }
};

export const issueInvoice = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.invoice.issue")) return sendError(res, 403, "Permission denied.", requestId);
    const userId = req.auth?.userId || req.auth?.id || null;

    const invoice = await InvoiceService.issueInvoice(req.params.invoiceId, scope.tenantId, userId);
    return sendSuccess(res, 200, "Invoice issued successfully.", invoice, requestId);
  } catch (error) {
    console.error("issueInvoice error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to issue invoice.", requestId);
  }
};

export const cancelInvoice = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.invoice.cancel")) return sendError(res, 403, "Permission denied.", requestId);
    const userId = req.auth?.userId || req.auth?.id || null;

    const invoice = await InvoiceService.cancelInvoice(req.params.invoiceId, req.body, scope.tenantId, userId);
    return sendSuccess(res, 200, "Invoice cancelled successfully.", invoice, requestId);
  } catch (error) {
    console.error("cancelInvoice error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to cancel invoice.", requestId);
  }
};

export const voidInvoice = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.invoice.cancel")) return sendError(res, 403, "Permission denied.", requestId);
    const userId = req.auth?.userId || req.auth?.id || null;

    const invoice = await InvoiceService.voidInvoice(req.params.invoiceId, req.body, scope.tenantId, userId);
    return sendSuccess(res, 200, "Invoice voided successfully.", invoice, requestId);
  } catch (error) {
    console.error("voidInvoice error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to void invoice.", requestId);
  }
};

export const closeInvoice = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.invoice.update")) return sendError(res, 403, "Permission denied.", requestId);
    const userId = req.auth?.userId || req.auth?.id || null;

    const invoice = await InvoiceService.closeInvoice(req.params.invoiceId, scope.tenantId, userId);
    return sendSuccess(res, 200, "Invoice closed successfully.", invoice, requestId);
  } catch (error) {
    console.error("closeInvoice error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to close invoice.", requestId);
  }
};
