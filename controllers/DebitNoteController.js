import DebitNoteService from "../services/DebitNoteService.js";
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
  if (message.includes("required") || message.includes("cannot") || message.includes("Cannot") || message.includes("Invalid") || message.includes("exceeds") || message.includes("must be")) return 400;
  return 500;
};

export const listDebitNotes = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.debitnote.read", "finance.read")) return sendError(res, 403, "Permission denied.", requestId);

    const result = await DebitNoteService.listDebitNotes(req.query, scope.tenantId);
    return sendSuccess(res, 200, "Debit notes retrieved successfully.", result, requestId);
  } catch (error) {
    console.error("listDebitNotes error:", error);
    return sendError(res, 500, error.message || "Failed to retrieve debit notes.", requestId);
  }
};

export const getDebitNote = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.debitnote.read", "finance.read")) return sendError(res, 403, "Permission denied.", requestId);

    const debitNote = await DebitNoteService.getDebitNoteById(req.params.debitNoteId, scope.tenantId);
    return sendSuccess(res, 200, "Debit note retrieved successfully.", debitNote, requestId);
  } catch (error) {
    console.error("getDebitNote error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to retrieve debit note.", requestId);
  }
};

export const createDebitNote = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.debitnote.create")) return sendError(res, 403, "Permission denied.", requestId);
    const userId = req.auth?.userId || req.auth?.id || null;

    const debitNote = await DebitNoteService.createDebitNote(req.body, scope.tenantId, userId);
    return sendSuccess(res, 201, "Debit note created successfully.", debitNote, requestId);
  } catch (error) {
    console.error("createDebitNote error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to create debit note.", requestId);
  }
};

export const approveDebitNote = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.debitnote.approve")) return sendError(res, 403, "Permission denied.", requestId);
    const userId = req.auth?.userId || req.auth?.id || null;

    const debitNote = await DebitNoteService.approveDebitNote(req.params.debitNoteId, scope.tenantId, userId);
    return sendSuccess(res, 200, "Debit note approved successfully.", debitNote, requestId);
  } catch (error) {
    console.error("approveDebitNote error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to approve debit note.", requestId);
  }
};

export const issueDebitNote = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.debitnote.issue")) return sendError(res, 403, "Permission denied.", requestId);
    const userId = req.auth?.userId || req.auth?.id || null;

    const debitNote = await DebitNoteService.issueDebitNote(req.params.debitNoteId, scope.tenantId, userId);
    return sendSuccess(res, 200, "Debit note issued successfully.", debitNote, requestId);
  } catch (error) {
    console.error("issueDebitNote error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to issue debit note.", requestId);
  }
};

export const allocateDebitNote = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.debitnote.issue")) return sendError(res, 403, "Permission denied.", requestId);
    const userId = req.auth?.userId || req.auth?.id || null;

    const debitNote = await DebitNoteService.allocateDebitNote(req.params.debitNoteId, scope.tenantId, userId);
    return sendSuccess(res, 200, "Debit note allocated successfully.", debitNote, requestId);
  } catch (error) {
    console.error("allocateDebitNote error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to allocate debit note.", requestId);
  }
};

export const cancelDebitNote = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.debitnote.cancel")) return sendError(res, 403, "Permission denied.", requestId);
    const userId = req.auth?.userId || req.auth?.id || null;

    const debitNote = await DebitNoteService.cancelDebitNote(req.params.debitNoteId, req.body, scope.tenantId, userId);
    return sendSuccess(res, 200, "Debit note cancelled successfully.", debitNote, requestId);
  } catch (error) {
    console.error("cancelDebitNote error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to cancel debit note.", requestId);
  }
};

export const voidDebitNote = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.debitnote.cancel")) return sendError(res, 403, "Permission denied.", requestId);
    const userId = req.auth?.userId || req.auth?.id || null;

    const debitNote = await DebitNoteService.voidDebitNote(req.params.debitNoteId, req.body, scope.tenantId, userId);
    return sendSuccess(res, 200, "Debit note voided successfully.", debitNote, requestId);
  } catch (error) {
    console.error("voidDebitNote error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to void debit note.", requestId);
  }
};

export const closeDebitNote = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.debitnote.issue")) return sendError(res, 403, "Permission denied.", requestId);
    const userId = req.auth?.userId || req.auth?.id || null;

    const debitNote = await DebitNoteService.closeDebitNote(req.params.debitNoteId, scope.tenantId, userId);
    return sendSuccess(res, 200, "Debit note closed successfully.", debitNote, requestId);
  } catch (error) {
    console.error("closeDebitNote error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to close debit note.", requestId);
  }
};
