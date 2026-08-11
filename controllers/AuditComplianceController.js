import AuditComplianceService from "../services/AuditComplianceService.js";
import { sendSuccess, sendError } from "../utils/apiResponse.js";
import { createRequestId } from "../utils/authTokens.js";
import { getAccessScope } from "../utils/accessScope.js";

const hasPermission = (req, ...keys) => {
  const permissions = req.auth?.permissions || [];
  return permissions.includes("admin") || keys.some((key) => permissions.includes(key));
};

const statusFromError = (error) => {
  const message = error.message || "";
  if (message.includes("already")) return 409;
  if (message.includes("not found")) return 404;
  if (message.includes("required") || message.includes("cannot") || message.includes("Cannot") || message.includes("Invalid") || message.includes("not yet supported") || message.includes("not supported")) return 400;
  return 500;
};

// ---- Audit Events ----

export const recordEvent = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "audit.event.create")) return sendError(res, 403, "Permission denied.", requestId);
    const userId = req.auth?.userId || req.auth?.id || null;

    const event = await AuditComplianceService.recordEvent({ ...req.body, ipAddress: req.body.ipAddress || req.ip || null }, scope.tenantId, userId);
    return sendSuccess(res, 201, "Audit event stored successfully.", event, requestId);
  } catch (error) {
    console.error("recordEvent error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to store audit event.", requestId);
  }
};

export const listEvents = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "audit.event.read")) return sendError(res, 403, "Permission denied.", requestId);

    const result = await AuditComplianceService.listEvents(req.query, scope.tenantId);
    return sendSuccess(res, 200, "Audit events retrieved successfully.", result, requestId);
  } catch (error) {
    console.error("listEvents error:", error);
    return sendError(res, 500, error.message || "Failed to retrieve audit events.", requestId);
  }
};

export const verifyIntegrity = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "audit.event.read")) return sendError(res, 403, "Permission denied.", requestId);

    const fromSequence = req.query.fromSequence ? parseInt(req.query.fromSequence, 10) : 1;
    const toSequence = req.query.toSequence ? parseInt(req.query.toSequence, 10) : null;
    const result = await AuditComplianceService.verifyChainIntegrity({ tenantId: scope.tenantId, fromSequence, toSequence });
    return sendSuccess(res, 200, "Chain integrity check completed.", result, requestId);
  } catch (error) {
    console.error("verifyIntegrity error:", error);
    return sendError(res, 500, error.message || "Failed to verify chain integrity.", requestId);
  }
};

export const getEntityTimeline = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "audit.event.read")) return sendError(res, 403, "Permission denied.", requestId);

    const items = await AuditComplianceService.getEntityTimeline({ tenantId: scope.tenantId, entityType: req.query.entityType, entityId: req.query.entityId });
    return sendSuccess(res, 200, "Entity timeline retrieved successfully.", { items }, requestId);
  } catch (error) {
    console.error("getEntityTimeline error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to retrieve entity timeline.", requestId);
  }
};

export const getUserActivity = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "audit.event.read")) return sendError(res, 403, "Permission denied.", requestId);

    const items = await AuditComplianceService.getUserActivity({ tenantId: scope.tenantId, userId: req.query.userId, dateFrom: req.query.dateFrom, dateTo: req.query.dateTo });
    return sendSuccess(res, 200, "User activity retrieved successfully.", { items }, requestId);
  } catch (error) {
    console.error("getUserActivity error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to retrieve user activity.", requestId);
  }
};

export const getCorrelatedEvents = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "audit.event.read")) return sendError(res, 403, "Permission denied.", requestId);

    const items = await AuditComplianceService.getCorrelatedEvents({ tenantId: scope.tenantId, correlationId: req.query.correlationId });
    return sendSuccess(res, 200, "Correlated events retrieved successfully.", { items }, requestId);
  } catch (error) {
    console.error("getCorrelatedEvents error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to retrieve correlated events.", requestId);
  }
};

export const getFinancialAuditEvent = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "audit.event.read")) return sendError(res, 403, "Permission denied.", requestId);

    const event = await AuditComplianceService.getEventById(req.params.eventId, scope.tenantId);
    return sendSuccess(res, 200, "Audit event retrieved successfully.", event, requestId);
  } catch (error) {
    console.error("getFinancialAuditEvent error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to retrieve audit event.", requestId);
  }
};

export const setLegalHold = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "audit.event.manage")) return sendError(res, 403, "Permission denied.", requestId);
    const userId = req.auth?.userId || req.auth?.id || null;

    const event = await AuditComplianceService.setLegalHold(req.params.eventId, scope.tenantId, userId, req.body.legalHold);
    return sendSuccess(res, 200, "Legal hold updated successfully.", event, requestId);
  } catch (error) {
    console.error("setLegalHold error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to update legal hold.", requestId);
  }
};

export const exportEvidence = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "audit.event.manage")) return sendError(res, 403, "Permission denied.", requestId);
    const userId = req.auth?.userId || req.auth?.id || null;

    const { format = "JSON", ...filterQuery } = req.body;
    const result = await AuditComplianceService.exportEvidence(filterQuery, format, scope.tenantId, userId);
    return sendSuccess(res, 201, "Evidence exported successfully.", result, requestId);
  } catch (error) {
    console.error("exportEvidence error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to export evidence.", requestId);
  }
};

// ---- Segregation of Duties ----

export const checkSegregationOfDuties = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "audit.event.read")) return sendError(res, 403, "Permission denied.", requestId);

    const result = await AuditComplianceService.checkSegregationOfDuties({ tenantId: scope.tenantId, entityType: req.params.entityType, entityId: req.params.entityId });
    return sendSuccess(res, 200, "Segregation of duties check completed.", result, requestId);
  } catch (error) {
    console.error("checkSegregationOfDuties error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to check segregation of duties.", requestId);
  }
};

export const checkRoleConflicts = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "audit.event.read")) return sendError(res, 403, "Permission denied.", requestId);

    const items = await AuditComplianceService.checkRoleConflicts({ tenantId: scope.tenantId });
    return sendSuccess(res, 200, "Role conflict check completed.", { items }, requestId);
  } catch (error) {
    console.error("checkRoleConflicts error:", error);
    return sendError(res, 500, error.message || "Failed to check role conflicts.", requestId);
  }
};

// ---- Compliance Policies ----

export const createPolicy = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "audit.compliance.manage")) return sendError(res, 403, "Permission denied.", requestId);
    const userId = req.auth?.userId || req.auth?.id || null;

    const policy = await AuditComplianceService.createPolicy(req.body, scope.tenantId, userId);
    return sendSuccess(res, 201, "Compliance policy created successfully.", policy, requestId);
  } catch (error) {
    console.error("createPolicy error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to create compliance policy.", requestId);
  }
};

export const listPolicies = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "audit.event.read")) return sendError(res, 403, "Permission denied.", requestId);

    const items = await AuditComplianceService.listPolicies(req.query, scope.tenantId);
    return sendSuccess(res, 200, "Compliance policies retrieved successfully.", { items }, requestId);
  } catch (error) {
    console.error("listPolicies error:", error);
    return sendError(res, 500, error.message || "Failed to retrieve compliance policies.", requestId);
  }
};

export const updatePolicyStatus = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "audit.compliance.manage")) return sendError(res, 403, "Permission denied.", requestId);
    const userId = req.auth?.userId || req.auth?.id || null;

    const policy = await AuditComplianceService.updatePolicyStatus(req.params.policyId, scope.tenantId, userId, req.body.status);
    return sendSuccess(res, 200, "Compliance policy status updated successfully.", policy, requestId);
  } catch (error) {
    console.error("updatePolicyStatus error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to update compliance policy status.", requestId);
  }
};
