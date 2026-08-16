import FinancialGovernanceService from "../services/FinancialGovernanceService.js";
import { sendError, sendSuccess } from "../utils/apiResponse.js";
import { getAccessScope } from "../utils/accessScope.js";
import { createRequestId } from "../utils/authTokens.js";

/**
 * Enterprise Financial Governance & Compliance Controller — Part 19.
 * Handles governance policy evaluation, Segregation of Duties (SoD),
 * evidence packages, fraud detection rules, and executive compliance dashboards.
 * Tenant-scoped only — no branchId per Master Architecture rules.
 */

const getScope = (req) => {
  const accessScope = getAccessScope(req);
  return {
    tenantId: accessScope?.tenantId || null,
    userId: req.auth?.userId || req.auth?.id || null
  };
};

const hasPermission = (req, ...keys) => {
  const permissions = req.auth?.permissions || [];
  return permissions.includes("admin") || keys.some((key) => permissions.includes(key));
};

const statusFromError = (err) => {
  const msg = err.message || "";
  if (/not found/i.test(msg)) return 404;
  if (/required|invalid|missing/i.test(msg)) return 400;
  return 500;
};

// 1. Evaluate Governance
export const evaluateGovernance = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const { tenantId, userId } = getScope(req);
    if (!tenantId) return sendError(res, 403, "Tenant context required.", requestId);
    if (!hasPermission(req, "finance.governance.manage")) return sendError(res, 403, "Permission denied.", requestId);

    const result = await FinancialGovernanceService.evaluateGovernance({
      tenantId,
      ...req.body,
      userId
    });

    return sendSuccess(res, 200, "Governance policy evaluated successfully.", result, requestId);
  } catch (err) {
    return sendError(res, statusFromError(err), err.message, requestId);
  }
};

// 2. Governance Policies
export const listPolicies = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const { tenantId } = getScope(req);
    if (!tenantId) return sendError(res, 403, "Tenant context required.", requestId);
    if (!hasPermission(req, "finance.governance.read", "finance.governance.manage")) return sendError(res, 403, "Permission denied.", requestId);

    const { status, policyType, page, limit } = req.query;
    const result = await FinancialGovernanceService.listPolicies({
      tenantId,
      status,
      policyType,
      page,
      limit
    });

    return sendSuccess(res, 200, "Governance policies retrieved successfully.", result, requestId);
  } catch (err) {
    return sendError(res, statusFromError(err), err.message, requestId);
  }
};

export const createPolicy = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const { tenantId, userId } = getScope(req);
    if (!tenantId) return sendError(res, 403, "Tenant context required.", requestId);
    if (!hasPermission(req, "finance.governance.manage")) return sendError(res, 403, "Permission denied.", requestId);

    const policy = await FinancialGovernanceService.createPolicy({
      tenantId,
      ...req.body,
      userId
    });

    return sendSuccess(res, 201, "Governance policy created successfully.", policy, requestId);
  } catch (err) {
    return sendError(res, statusFromError(err), err.message, requestId);
  }
};

// 3. Segregation of Duties (SoD) Rules
export const listSoDRules = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const { tenantId } = getScope(req);
    if (!tenantId) return sendError(res, 403, "Tenant context required.", requestId);
    if (!hasPermission(req, "finance.governance.read", "finance.governance.manage")) return sendError(res, 403, "Permission denied.", requestId);

    const { status } = req.query;
    const rules = await FinancialGovernanceService.listSoDRules({ tenantId, status });

    return sendSuccess(res, 200, "Segregation of Duties rules retrieved successfully.", rules, requestId);
  } catch (err) {
    return sendError(res, statusFromError(err), err.message, requestId);
  }
};

export const createSoDRule = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const { tenantId, userId } = getScope(req);
    if (!tenantId) return sendError(res, 403, "Tenant context required.", requestId);
    if (!hasPermission(req, "finance.governance.manage")) return sendError(res, 403, "Permission denied.", requestId);

    const rule = await FinancialGovernanceService.createSoDRule({
      tenantId,
      ...req.body,
      userId
    });

    return sendSuccess(res, 201, "Segregation of Duties rule created successfully.", rule, requestId);
  } catch (err) {
    return sendError(res, statusFromError(err), err.message, requestId);
  }
};

// 4. Evidence Repository
export const listEvidencePackages = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const { tenantId } = getScope(req);
    if (!tenantId) return sendError(res, 403, "Tenant context required.", requestId);
    if (!hasPermission(req, "finance.governance.read", "finance.governance.manage")) return sendError(res, 403, "Permission denied.", requestId);

    const { transactionId, operation, page, limit } = req.query;
    const result = await FinancialGovernanceService.listEvidencePackages({
      tenantId,
      transactionId,
      operation,
      page,
      limit
    });

    return sendSuccess(res, 200, "Governance evidence packages retrieved successfully.", result, requestId);
  } catch (err) {
    return sendError(res, statusFromError(err), err.message, requestId);
  }
};

export const getEvidenceById = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const { tenantId } = getScope(req);
    if (!tenantId) return sendError(res, 403, "Tenant context required.", requestId);
    if (!hasPermission(req, "finance.governance.read", "finance.governance.manage")) return sendError(res, 403, "Permission denied.", requestId);

    const evidence = await FinancialGovernanceService.getEvidenceById({
      tenantId,
      evidenceId: req.params.evidenceId
    });

    return sendSuccess(res, 200, "Governance evidence package retrieved successfully.", evidence, requestId);
  } catch (err) {
    return sendError(res, statusFromError(err), err.message, requestId);
  }
};

// 5. Fraud Detection Rules
export const listFraudRules = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const { tenantId } = getScope(req);
    if (!tenantId) return sendError(res, 403, "Tenant context required.", requestId);
    if (!hasPermission(req, "finance.governance.read", "finance.governance.manage")) return sendError(res, 403, "Permission denied.", requestId);

    const { status } = req.query;
    const rules = await FinancialGovernanceService.listFraudRules({ tenantId, status });

    return sendSuccess(res, 200, "Fraud detection rules retrieved successfully.", rules, requestId);
  } catch (err) {
    return sendError(res, statusFromError(err), err.message, requestId);
  }
};

export const createFraudRule = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const { tenantId, userId } = getScope(req);
    if (!tenantId) return sendError(res, 403, "Tenant context required.", requestId);
    if (!hasPermission(req, "finance.governance.manage")) return sendError(res, 403, "Permission denied.", requestId);

    const rule = await FinancialGovernanceService.createFraudRule({
      tenantId,
      ...req.body,
      userId
    });

    return sendSuccess(res, 201, "Fraud detection rule created successfully.", rule, requestId);
  } catch (err) {
    return sendError(res, statusFromError(err), err.message, requestId);
  }
};

// 6. Governance Dashboard
export const getGovernanceDashboard = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const { tenantId } = getScope(req);
    if (!tenantId) return sendError(res, 403, "Tenant context required.", requestId);
    if (!hasPermission(req, "finance.governance.read", "finance.governance.manage")) return sendError(res, 403, "Permission denied.", requestId);

    const dashboard = await FinancialGovernanceService.getGovernanceDashboard({ tenantId });
    return sendSuccess(res, 200, "Governance dashboard retrieved successfully.", dashboard, requestId);
  } catch (err) {
    return sendError(res, statusFromError(err), err.message, requestId);
  }
};
