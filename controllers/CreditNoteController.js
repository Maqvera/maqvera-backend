import CreditNoteService from "../services/CreditNoteService.js";
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
  if (message.includes("required") || message.includes("cannot") || message.includes("Invalid") || message.includes("exceeds") || message.includes("must be")) return 400;
  return 500;
};

export const listCreditNotes = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.creditnote.read", "finance.read")) return sendError(res, 403, "Permission denied.", requestId);

    const result = await CreditNoteService.listCreditNotes(req.query, scope.tenantId);
    return sendSuccess(res, 200, "Credit notes retrieved successfully.", result, requestId);
  } catch (error) {
    console.error("listCreditNotes error:", error);
    return sendError(res, 500, error.message || "Failed to retrieve credit notes.", requestId);
  }
};

export const getCreditNote = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.creditnote.read", "finance.read")) return sendError(res, 403, "Permission denied.", requestId);

    const creditNote = await CreditNoteService.getCreditNoteById(req.params.creditNoteId, scope.tenantId);
    return sendSuccess(res, 200, "Credit note retrieved successfully.", creditNote, requestId);
  } catch (error) {
    console.error("getCreditNote error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to retrieve credit note.", requestId);
  }
};

export const createCreditNote = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.creditnote.create")) return sendError(res, 403, "Permission denied.", requestId);
    const userId = req.auth?.userId || req.auth?.id || null;

    const creditNote = await CreditNoteService.createCreditNote(req.body, scope.tenantId, userId);
    return sendSuccess(res, 201, "Credit note created successfully.", creditNote, requestId);
  } catch (error) {
    console.error("createCreditNote error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to create credit note.", requestId);
  }
};

export const approveCreditNote = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.creditnote.approve")) return sendError(res, 403, "Permission denied.", requestId);
    const userId = req.auth?.userId || req.auth?.id || null;

    const creditNote = await CreditNoteService.approveCreditNote(req.params.creditNoteId, scope.tenantId, userId);
    return sendSuccess(res, 200, "Credit note approved successfully.", creditNote, requestId);
  } catch (error) {
    console.error("approveCreditNote error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to approve credit note.", requestId);
  }
};

export const issueCreditNote = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.creditnote.issue")) return sendError(res, 403, "Permission denied.", requestId);
    const userId = req.auth?.userId || req.auth?.id || null;

    const creditNote = await CreditNoteService.issueCreditNote(req.params.creditNoteId, scope.tenantId, userId);
    return sendSuccess(res, 200, "Credit note issued successfully.", creditNote, requestId);
  } catch (error) {
    console.error("issueCreditNote error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to issue credit note.", requestId);
  }
};

export const allocateCreditNote = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.creditnote.issue")) return sendError(res, 403, "Permission denied.", requestId);
    const userId = req.auth?.userId || req.auth?.id || null;

    const creditNote = await CreditNoteService.allocateCreditNote(req.params.creditNoteId, scope.tenantId, userId);
    return sendSuccess(res, 200, "Credit note allocated successfully.", creditNote, requestId);
  } catch (error) {
    console.error("allocateCreditNote error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to allocate credit note.", requestId);
  }
};

export const cancelCreditNote = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.creditnote.cancel")) return sendError(res, 403, "Permission denied.", requestId);
    const userId = req.auth?.userId || req.auth?.id || null;

    const creditNote = await CreditNoteService.cancelCreditNote(req.params.creditNoteId, req.body, scope.tenantId, userId);
    return sendSuccess(res, 200, "Credit note cancelled successfully.", creditNote, requestId);
  } catch (error) {
    console.error("cancelCreditNote error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to cancel credit note.", requestId);
  }
};

export const voidCreditNote = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.creditnote.cancel")) return sendError(res, 403, "Permission denied.", requestId);
    const userId = req.auth?.userId || req.auth?.id || null;

    const creditNote = await CreditNoteService.voidCreditNote(req.params.creditNoteId, req.body, scope.tenantId, userId);
    return sendSuccess(res, 200, "Credit note voided successfully.", creditNote, requestId);
  } catch (error) {
    console.error("voidCreditNote error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to void credit note.", requestId);
  }
};

export const closeCreditNote = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.creditnote.issue")) return sendError(res, 403, "Permission denied.", requestId);
    const userId = req.auth?.userId || req.auth?.id || null;

    const creditNote = await CreditNoteService.closeCreditNote(req.params.creditNoteId, scope.tenantId, userId);
    return sendSuccess(res, 200, "Credit note closed successfully.", creditNote, requestId);
  } catch (error) {
    console.error("closeCreditNote error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to close credit note.", requestId);
  }
};
