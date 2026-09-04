import VendorPaymentService from "../services/VendorPaymentService.js";
import { sendSuccess, sendError } from "../utils/apiResponse.js";
import { createRequestId } from "../utils/authTokens.js";
import { getAccessScope } from "../utils/accessScope.js";

const hasPermission = (req, ...keys) => {
  const permissions = req.auth?.permissions || [];
  return permissions.includes("admin") || keys.some((key) => permissions.includes(key));
};

const statusFromError = (error) => {
  const message = error.message || "";
  if (message.includes("already exists") || message.includes("Duplicate payment")) return 409;
  if (message.includes("not found")) return 404;
  if (message.includes("required") || message.includes("cannot") || message.includes("Cannot") || message.includes("Invalid") || message.includes("exceeds") || message.includes("must be") || message.includes("mismatch") || message.includes("Insufficient") || message.includes("failed checksum") || message.includes("valid format") || message.includes("already approved")) return 400;
  return 500;
};

// ---- Vendor Bank Accounts ----

export const addVendorBankAccount = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.vendorpayment.manage")) return sendError(res, 403, "Permission denied.", requestId);
    const userId = req.auth?.userId || req.auth?.id || null;

    const vendor = await VendorPaymentService.addVendorBankAccount(req.params.vendorId, req.body, scope.tenantId, userId);
    return sendSuccess(res, 201, "Vendor bank account added successfully.", vendor, requestId);
  } catch (error) {
    console.error("addVendorBankAccount error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to add vendor bank account.", requestId);
  }
};

export const listVendorBankAccounts = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.vendorpayment.read", "finance.read")) return sendError(res, 403, "Permission denied.", requestId);

    const items = await VendorPaymentService.listVendorBankAccounts(req.params.vendorId, scope.tenantId);
    return sendSuccess(res, 200, "Vendor bank accounts retrieved successfully.", { items }, requestId);
  } catch (error) {
    console.error("listVendorBankAccounts error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to retrieve vendor bank accounts.", requestId);
  }
};

export const setPrimaryVendorBankAccount = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.vendorpayment.manage")) return sendError(res, 403, "Permission denied.", requestId);
    const userId = req.auth?.userId || req.auth?.id || null;

    const vendor = await VendorPaymentService.setPrimaryVendorBankAccount(req.params.vendorId, req.params.bankAccountRecordId, scope.tenantId, userId);
    return sendSuccess(res, 200, "Primary vendor bank account updated successfully.", vendor, requestId);
  } catch (error) {
    console.error("setPrimaryVendorBankAccount error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to update primary vendor bank account.", requestId);
  }
};

// ---- Vendor Payments ----

export const listVendorPayments = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.vendorpayment.read", "finance.read")) return sendError(res, 403, "Permission denied.", requestId);

    const result = await VendorPaymentService.listVendorPayments(req.query, scope.tenantId);
    return sendSuccess(res, 200, "Vendor payments retrieved successfully.", result, requestId);
  } catch (error) {
    console.error("listVendorPayments error:", error);
    return sendError(res, 500, error.message || "Failed to retrieve vendor payments.", requestId);
  }
};

export const getVendorPayment = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.vendorpayment.read", "finance.read")) return sendError(res, 403, "Permission denied.", requestId);

    const vendorPayment = await VendorPaymentService.getVendorPaymentById(req.params.vendorPaymentId, scope.tenantId);
    return sendSuccess(res, 200, "Vendor payment retrieved successfully.", vendorPayment, requestId);
  } catch (error) {
    console.error("getVendorPayment error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to retrieve vendor payment.", requestId);
  }
};

export const createVendorPaymentProposal = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.vendorpayment.create")) return sendError(res, 403, "Permission denied.", requestId);
    const userId = req.auth?.userId || req.auth?.id || null;

    const vendorPayment = await VendorPaymentService.createVendorPaymentProposal(req.body, scope.tenantId, userId);
    return sendSuccess(res, 201, "Vendor payment proposal created successfully.", vendorPayment, requestId);
  } catch (error) {
    console.error("createVendorPaymentProposal error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to create vendor payment proposal.", requestId);
  }
};

export const approveVendorPayment = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.vendorpayment.approve")) return sendError(res, 403, "Permission denied.", requestId);
    const userId = req.auth?.userId || req.auth?.id || null;

    const vendorPayment = await VendorPaymentService.approveVendorPayment(req.params.vendorPaymentId, scope.tenantId, userId);
    return sendSuccess(res, 200, "Vendor payment approval recorded successfully.", vendorPayment, requestId);
  } catch (error) {
    console.error("approveVendorPayment error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to approve vendor payment.", requestId);
  }
};

export const rejectVendorPayment = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.vendorpayment.approve")) return sendError(res, 403, "Permission denied.", requestId);
    const userId = req.auth?.userId || req.auth?.id || null;

    const vendorPayment = await VendorPaymentService.rejectVendorPayment(req.params.vendorPaymentId, req.body, scope.tenantId, userId);
    return sendSuccess(res, 200, "Vendor payment rejected successfully.", vendorPayment, requestId);
  } catch (error) {
    console.error("rejectVendorPayment error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to reject vendor payment.", requestId);
  }
};

export const cancelVendorPayment = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.vendorpayment.create")) return sendError(res, 403, "Permission denied.", requestId);
    const userId = req.auth?.userId || req.auth?.id || null;

    const vendorPayment = await VendorPaymentService.cancelVendorPayment(req.params.vendorPaymentId, req.body, scope.tenantId, userId);
    return sendSuccess(res, 200, "Vendor payment cancelled successfully.", vendorPayment, requestId);
  } catch (error) {
    console.error("cancelVendorPayment error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to cancel vendor payment.", requestId);
  }
};

export const holdVendorPayment = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.vendorpayment.manage")) return sendError(res, 403, "Permission denied.", requestId);
    const userId = req.auth?.userId || req.auth?.id || null;

    const vendorPayment = await VendorPaymentService.holdVendorPayment(req.params.vendorPaymentId, req.body, scope.tenantId, userId);
    return sendSuccess(res, 200, "Vendor payment placed on hold successfully.", vendorPayment, requestId);
  } catch (error) {
    console.error("holdVendorPayment error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to hold vendor payment.", requestId);
  }
};

export const releaseVendorPaymentHold = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.vendorpayment.manage")) return sendError(res, 403, "Permission denied.", requestId);
    const userId = req.auth?.userId || req.auth?.id || null;

    const vendorPayment = await VendorPaymentService.releaseVendorPaymentHold(req.params.vendorPaymentId, scope.tenantId, userId);
    return sendSuccess(res, 200, "Vendor payment hold released successfully.", vendorPayment, requestId);
  } catch (error) {
    console.error("releaseVendorPaymentHold error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to release vendor payment hold.", requestId);
  }
};

export const scheduleVendorPayment = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.vendorpayment.manage")) return sendError(res, 403, "Permission denied.", requestId);
    const userId = req.auth?.userId || req.auth?.id || null;

    const vendorPayment = await VendorPaymentService.scheduleVendorPayment(req.params.vendorPaymentId, scope.tenantId, userId);
    return sendSuccess(res, 200, "Vendor payment scheduled successfully.", vendorPayment, requestId);
  } catch (error) {
    console.error("scheduleVendorPayment error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to schedule vendor payment.", requestId);
  }
};

export const executeVendorPayment = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.vendorpayment.manage")) return sendError(res, 403, "Permission denied.", requestId);
    const userId = req.auth?.userId || req.auth?.id || null;

    const vendorPayment = await VendorPaymentService.executeVendorPayment(req.params.vendorPaymentId, scope.tenantId, userId);
    return sendSuccess(res, 200, "Vendor payment execution completed.", vendorPayment, requestId);
  } catch (error) {
    console.error("executeVendorPayment error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to execute vendor payment.", requestId);
  }
};

export const generatePaymentFile = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.vendorpayment.manage")) return sendError(res, 403, "Permission denied.", requestId);
    const userId = req.auth?.userId || req.auth?.id || null;

    const { vendorPaymentIds, format } = req.body;
    if (!Array.isArray(vendorPaymentIds) || vendorPaymentIds.length === 0) return sendError(res, 400, "vendorPaymentIds must be a non-empty array.", requestId);

    const fileGeneration = await VendorPaymentService.generatePaymentFile(vendorPaymentIds, { format }, scope.tenantId, userId);
    return sendSuccess(res, 201, "Payment file generated successfully.", fileGeneration, requestId);
  } catch (error) {
    console.error("generatePaymentFile error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to generate payment file.", requestId);
  }
};

// ---- Payment Batches ----

export const listPaymentBatches = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.vendorpayment.read", "finance.read")) return sendError(res, 403, "Permission denied.", requestId);

    const items = await VendorPaymentService.listPaymentBatches(req.query, scope.tenantId);
    return sendSuccess(res, 200, "Payment batches retrieved successfully.", { items }, requestId);
  } catch (error) {
    console.error("listPaymentBatches error:", error);
    return sendError(res, 500, error.message || "Failed to retrieve payment batches.", requestId);
  }
};

export const getPaymentBatch = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.vendorpayment.read", "finance.read")) return sendError(res, 403, "Permission denied.", requestId);

    const batch = await VendorPaymentService.getPaymentBatchById(req.params.batchId, scope.tenantId);
    return sendSuccess(res, 200, "Payment batch retrieved successfully.", batch, requestId);
  } catch (error) {
    console.error("getPaymentBatch error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to retrieve payment batch.", requestId);
  }
};

export const createPaymentBatch = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.vendorpayment.manage")) return sendError(res, 403, "Permission denied.", requestId);
    const userId = req.auth?.userId || req.auth?.id || null;

    const batch = await VendorPaymentService.createPaymentBatch(req.body, scope.tenantId, userId);
    return sendSuccess(res, 201, "Payment batch created successfully.", batch, requestId);
  } catch (error) {
    console.error("createPaymentBatch error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to create payment batch.", requestId);
  }
};

export const executePaymentBatch = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.vendorpayment.manage")) return sendError(res, 403, "Permission denied.", requestId);
    const userId = req.auth?.userId || req.auth?.id || null;

    const batch = await VendorPaymentService.executePaymentBatch(req.params.batchId, scope.tenantId, userId);
    return sendSuccess(res, 200, "Payment batch execution completed.", batch, requestId);
  } catch (error) {
    console.error("executePaymentBatch error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to execute payment batch.", requestId);
  }
};

// ---- Advances & AI Timing ----

export const createVendorAdvance = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.vendorpayment.create")) return sendError(res, 403, "Permission denied.", requestId);
    const userId = req.auth?.userId || req.auth?.id || null;

    const result = await VendorPaymentService.createVendorAdvance(req.body, scope.tenantId, userId);
    return sendSuccess(res, 201, "Vendor advance created successfully.", result, requestId);
  } catch (error) {
    console.error("createVendorAdvance error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to create vendor advance.", requestId);
  }
};

export const suggestPaymentTiming = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.vendorpayment.read", "finance.read")) return sendError(res, 403, "Permission denied.", requestId);

    const result = await VendorPaymentService.suggestPaymentTiming(scope.tenantId);
    return sendSuccess(res, 200, "Payment timing recommendations generated.", result, requestId);
  } catch (error) {
    console.error("suggestPaymentTiming error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to generate payment timing recommendations.", requestId);
  }
};
