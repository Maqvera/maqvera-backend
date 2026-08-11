import JournalService from "../services/JournalService.js";
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
  if (message.includes("required") || message.includes("cannot") || message.includes("out of balance") || message.includes("exceeds") || message.includes("does not")) return 400;
  return 500;
};

export const listJournals = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.journal.read", "finance.read")) return sendError(res, 403, "Permission denied.", requestId);

    const result = await JournalService.listJournals(req.query, scope.tenantId);
    return sendSuccess(res, 200, "Journals retrieved successfully.", result, requestId);
  } catch (error) {
    console.error("listJournals error:", error);
    return sendError(res, 500, error.message || "Failed to retrieve journals.", requestId);
  }
};

export const getJournal = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.journal.read", "finance.read")) return sendError(res, 403, "Permission denied.", requestId);

    const journal = await JournalService.getJournalById(req.params.journalId, scope.tenantId);
    return sendSuccess(res, 200, "Journal retrieved successfully.", journal, requestId);
  } catch (error) {
    console.error("getJournal error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to retrieve journal.", requestId);
  }
};

export const createJournal = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.journal.create")) return sendError(res, 403, "Permission denied.", requestId);
    const userId = req.auth?.userId || req.auth?.id || null;

    const journal = await JournalService.createJournal(req.body, scope.tenantId, userId);
    return sendSuccess(res, 201, "Journal created successfully.", journal, requestId);
  } catch (error) {
    console.error("createJournal error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to create journal.", requestId);
  }
};

export const updateJournal = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.journal.update")) return sendError(res, 403, "Permission denied.", requestId);
    const userId = req.auth?.userId || req.auth?.id || null;

    const journal = await JournalService.updateJournal(req.params.journalId, req.body, scope.tenantId, userId);
    return sendSuccess(res, 200, "Journal updated successfully.", journal, requestId);
  } catch (error) {
    console.error("updateJournal error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to update journal.", requestId);
  }
};

export const approveJournal = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.journal.approve")) return sendError(res, 403, "Permission denied.", requestId);
    const userId = req.auth?.userId || req.auth?.id || null;

    const journal = await JournalService.approveJournal(req.params.journalId, scope.tenantId, userId);
    return sendSuccess(res, 200, "Journal approved successfully.", journal, requestId);
  } catch (error) {
    console.error("approveJournal error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to approve journal.", requestId);
  }
};

export const rejectJournal = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.journal.approve")) return sendError(res, 403, "Permission denied.", requestId);
    const userId = req.auth?.userId || req.auth?.id || null;

    const journal = await JournalService.rejectJournal(req.params.journalId, req.body, scope.tenantId, userId);
    return sendSuccess(res, 200, "Journal rejected.", journal, requestId);
  } catch (error) {
    console.error("rejectJournal error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to reject journal.", requestId);
  }
};

export const cancelJournal = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.journal.update")) return sendError(res, 403, "Permission denied.", requestId);
    const userId = req.auth?.userId || req.auth?.id || null;

    const journal = await JournalService.cancelJournal(req.params.journalId, scope.tenantId, userId);
    return sendSuccess(res, 200, "Journal cancelled.", journal, requestId);
  } catch (error) {
    console.error("cancelJournal error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to cancel journal.", requestId);
  }
};

export const postJournal = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.journal.post")) return sendError(res, 403, "Permission denied.", requestId);
    const userId = req.auth?.userId || req.auth?.id || null;

    const journal = await JournalService.postJournal(req.params.journalId, scope.tenantId, userId);
    return sendSuccess(res, 200, "Journal posted to the General Ledger successfully.", journal, requestId);
  } catch (error) {
    console.error("postJournal error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to post journal.", requestId);
  }
};

export const reverseJournal = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.journal.reverse")) return sendError(res, 403, "Permission denied.", requestId);
    const userId = req.auth?.userId || req.auth?.id || null;

    const result = await JournalService.reverseJournal(req.params.journalId, req.body, scope.tenantId, userId);
    return sendSuccess(res, 201, "Journal reversed successfully.", result, requestId);
  } catch (error) {
    console.error("reverseJournal error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to reverse journal.", requestId);
  }
};
