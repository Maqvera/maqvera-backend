import ApprovalWorkflowService from "../services/ApprovalWorkflowService.js";
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
  if (message.includes("required") || message.includes("cannot") || message.includes("Cannot") || message.includes("Invalid") || message.includes("must be") || message.includes("No active") || message.includes("No matching") || message.includes("not currently") || message.includes("already recorded") || message.includes("not an assigned")) return 400;
  if (message.includes("not an assigned approver") || message.includes("no active delegation")) return 403;
  return 500;
};

// ---- Workflow Definitions ----

export const createWorkflowDefinition = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.approvalworkflow.manage")) return sendError(res, 403, "Permission denied.", requestId);
    const userId = req.auth?.userId || req.auth?.id || null;

    const definition = await ApprovalWorkflowService.createWorkflowDefinition(req.body, scope.tenantId, userId);
    return sendSuccess(res, 201, "Approval workflow definition created successfully.", definition, requestId);
  } catch (error) {
    console.error("createWorkflowDefinition error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to create approval workflow definition.", requestId);
  }
};

export const listWorkflowDefinitions = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.approvalworkflow.read", "finance.read")) return sendError(res, 403, "Permission denied.", requestId);

    const items = await ApprovalWorkflowService.listWorkflowDefinitions(req.query, scope.tenantId);
    return sendSuccess(res, 200, "Approval workflow definitions retrieved successfully.", { items }, requestId);
  } catch (error) {
    console.error("listWorkflowDefinitions error:", error);
    return sendError(res, 500, error.message || "Failed to retrieve approval workflow definitions.", requestId);
  }
};

export const getWorkflowDefinition = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.approvalworkflow.read", "finance.read")) return sendError(res, 403, "Permission denied.", requestId);

    const definition = await ApprovalWorkflowService.getWorkflowDefinitionById(req.params.definitionId, scope.tenantId);
    return sendSuccess(res, 200, "Approval workflow definition retrieved successfully.", definition, requestId);
  } catch (error) {
    console.error("getWorkflowDefinition error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to retrieve approval workflow definition.", requestId);
  }
};

export const approveWorkflowDefinition = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.approvalworkflow.approve")) return sendError(res, 403, "Permission denied.", requestId);
    const userId = req.auth?.userId || req.auth?.id || null;

    const definition = await ApprovalWorkflowService.approveWorkflowDefinition(req.params.definitionId, scope.tenantId, userId);
    return sendSuccess(res, 200, "Approval workflow definition approved successfully.", definition, requestId);
  } catch (error) {
    console.error("approveWorkflowDefinition error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to approve approval workflow definition.", requestId);
  }
};

export const archiveWorkflowDefinition = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.approvalworkflow.manage")) return sendError(res, 403, "Permission denied.", requestId);
    const userId = req.auth?.userId || req.auth?.id || null;

    const definition = await ApprovalWorkflowService.archiveWorkflowDefinition(req.params.definitionId, scope.tenantId, userId);
    return sendSuccess(res, 200, "Approval workflow definition archived successfully.", definition, requestId);
  } catch (error) {
    console.error("archiveWorkflowDefinition error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to archive approval workflow definition.", requestId);
  }
};

// ---- Approval Requests ----

export const startApproval = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.approvalworkflow.manage")) return sendError(res, 403, "Permission denied.", requestId);
    const userId = req.auth?.userId || req.auth?.id || null;

    const request = await ApprovalWorkflowService.startApproval(req.body, scope.tenantId, userId);
    return sendSuccess(res, 201, "Approval workflow started successfully.", request, requestId);
  } catch (error) {
    console.error("startApproval error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to start approval workflow.", requestId);
  }
};

export const listApprovalRequests = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.approvalworkflow.read", "finance.read")) return sendError(res, 403, "Permission denied.", requestId);

    const result = await ApprovalWorkflowService.listApprovalRequests(req.query, scope.tenantId);
    return sendSuccess(res, 200, "Approval requests retrieved successfully.", result, requestId);
  } catch (error) {
    console.error("listApprovalRequests error:", error);
    return sendError(res, 500, error.message || "Failed to retrieve approval requests.", requestId);
  }
};

export const getApprovalRequest = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.approvalworkflow.read", "finance.read")) return sendError(res, 403, "Permission denied.", requestId);

    const request = await ApprovalWorkflowService.getApprovalRequestById(req.params.approvalId, scope.tenantId);
    return sendSuccess(res, 200, "Approval request retrieved successfully.", request, requestId);
  } catch (error) {
    console.error("getApprovalRequest error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to retrieve approval request.", requestId);
  }
};

export const recordDecision = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    const userId = req.auth?.userId || req.auth?.id || null;
    if (!userId) return sendError(res, 403, "Authenticated user context is required.", requestId);

    const request = await ApprovalWorkflowService.recordDecision(req.params.approvalId, req.body, scope.tenantId, userId);
    return sendSuccess(res, 200, "Approval decision recorded successfully.", request, requestId);
  } catch (error) {
    console.error("recordDecision error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to record approval decision.", requestId);
  }
};

export const cancelApprovalRequest = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.approvalworkflow.manage")) return sendError(res, 403, "Permission denied.", requestId);
    const userId = req.auth?.userId || req.auth?.id || null;

    const request = await ApprovalWorkflowService.cancelApprovalRequest(req.params.approvalId, req.body, scope.tenantId, userId);
    return sendSuccess(res, 200, "Approval request cancelled successfully.", request, requestId);
  } catch (error) {
    console.error("cancelApprovalRequest error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to cancel approval request.", requestId);
  }
};

// ---- Delegation ----

export const createDelegation = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.approvalworkflow.manage")) return sendError(res, 403, "Permission denied.", requestId);
    const userId = req.auth?.userId || req.auth?.id || null;

    const delegation = await ApprovalWorkflowService.createDelegation(req.body, scope.tenantId, userId);
    return sendSuccess(res, 201, "Approval delegation created successfully.", delegation, requestId);
  } catch (error) {
    console.error("createDelegation error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to create approval delegation.", requestId);
  }
};

export const listDelegations = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.approvalworkflow.read", "finance.read")) return sendError(res, 403, "Permission denied.", requestId);

    const items = await ApprovalWorkflowService.listDelegations(req.query, scope.tenantId);
    return sendSuccess(res, 200, "Approval delegations retrieved successfully.", { items }, requestId);
  } catch (error) {
    console.error("listDelegations error:", error);
    return sendError(res, 500, error.message || "Failed to retrieve approval delegations.", requestId);
  }
};

export const revokeDelegation = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.approvalworkflow.manage")) return sendError(res, 403, "Permission denied.", requestId);
    const userId = req.auth?.userId || req.auth?.id || null;

    const delegation = await ApprovalWorkflowService.revokeDelegation(req.params.delegationId, scope.tenantId, userId);
    return sendSuccess(res, 200, "Approval delegation revoked successfully.", delegation, requestId);
  } catch (error) {
    console.error("revokeDelegation error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to revoke approval delegation.", requestId);
  }
};
