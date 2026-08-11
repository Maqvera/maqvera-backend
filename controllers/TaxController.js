import TaxService from "../services/TaxService.js";
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
  if (message.includes("required") || message.includes("cannot") || message.includes("Cannot") || message.includes("Invalid") || message.includes("must") || message.includes("exceeds") || message.includes("No active tax rule") || message.includes("No active withholding") || message.includes("too deep")) return 400;
  return 500;
};

// ---- Tax Rules ----

export const createTaxRule = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.tax.manage")) return sendError(res, 403, "Permission denied.", requestId);
    const userId = req.auth?.userId || req.auth?.id || null;

    const taxRule = await TaxService.createTaxRule(req.body, scope.tenantId, userId);
    return sendSuccess(res, 201, "Tax rule created successfully.", taxRule, requestId);
  } catch (error) {
    console.error("createTaxRule error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to create tax rule.", requestId);
  }
};

export const listTaxRules = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.tax.read", "finance.read")) return sendError(res, 403, "Permission denied.", requestId);

    const result = await TaxService.listTaxRules(req.query, scope.tenantId);
    return sendSuccess(res, 200, "Tax rules retrieved successfully.", result, requestId);
  } catch (error) {
    console.error("listTaxRules error:", error);
    return sendError(res, 500, error.message || "Failed to retrieve tax rules.", requestId);
  }
};

export const getTaxRule = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.tax.read", "finance.read")) return sendError(res, 403, "Permission denied.", requestId);

    const taxRule = await TaxService.getTaxRuleById(req.params.taxRuleId, scope.tenantId);
    return sendSuccess(res, 200, "Tax rule retrieved successfully.", taxRule, requestId);
  } catch (error) {
    console.error("getTaxRule error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to retrieve tax rule.", requestId);
  }
};

export const approveTaxRule = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.tax.approve")) return sendError(res, 403, "Permission denied.", requestId);
    const userId = req.auth?.userId || req.auth?.id || null;

    const taxRule = await TaxService.approveTaxRule(req.params.taxRuleId, scope.tenantId, userId);
    return sendSuccess(res, 200, "Tax rule approved successfully.", taxRule, requestId);
  } catch (error) {
    console.error("approveTaxRule error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to approve tax rule.", requestId);
  }
};

export const archiveTaxRule = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.tax.manage")) return sendError(res, 403, "Permission denied.", requestId);
    const userId = req.auth?.userId || req.auth?.id || null;

    const taxRule = await TaxService.archiveTaxRule(req.params.taxRuleId, scope.tenantId, userId);
    return sendSuccess(res, 200, "Tax rule archived successfully.", taxRule, requestId);
  } catch (error) {
    console.error("archiveTaxRule error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to archive tax rule.", requestId);
  }
};

// ---- Tax Calculation ----

export const calculateTax = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.tax.read", "finance.read")) return sendError(res, 403, "Permission denied.", requestId);
    const userId = req.auth?.userId || req.auth?.id || null;

    const result = await TaxService.calculateTax(req.body, scope.tenantId, userId);
    return sendSuccess(res, 201, "Tax calculated successfully.", result, requestId);
  } catch (error) {
    console.error("calculateTax error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to calculate tax.", requestId);
  }
};

export const calculateWithholdingTax = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.tax.read", "finance.read")) return sendError(res, 403, "Permission denied.", requestId);
    const userId = req.auth?.userId || req.auth?.id || null;

    const result = await TaxService.calculateWithholdingTax(req.body, scope.tenantId, userId);
    return sendSuccess(res, 201, "Withholding tax calculated successfully.", result, requestId);
  } catch (error) {
    console.error("calculateWithholdingTax error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to calculate withholding tax.", requestId);
  }
};

// ---- Tax Exemptions ----

export const createExemption = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.tax.manage")) return sendError(res, 403, "Permission denied.", requestId);
    const userId = req.auth?.userId || req.auth?.id || null;

    const exemption = await TaxService.createExemption(req.body, scope.tenantId, userId);
    return sendSuccess(res, 201, "Tax exemption created successfully.", exemption, requestId);
  } catch (error) {
    console.error("createExemption error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to create tax exemption.", requestId);
  }
};

export const listExemptions = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.tax.read", "finance.read")) return sendError(res, 403, "Permission denied.", requestId);

    const items = await TaxService.listExemptions(req.query, scope.tenantId);
    return sendSuccess(res, 200, "Tax exemptions retrieved successfully.", { items }, requestId);
  } catch (error) {
    console.error("listExemptions error:", error);
    return sendError(res, 500, error.message || "Failed to retrieve tax exemptions.", requestId);
  }
};

export const revokeExemption = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.tax.manage")) return sendError(res, 403, "Permission denied.", requestId);
    const userId = req.auth?.userId || req.auth?.id || null;

    const exemption = await TaxService.revokeExemption(req.params.exemptionId, req.body, scope.tenantId, userId);
    return sendSuccess(res, 200, "Tax exemption revoked successfully.", exemption, requestId);
  } catch (error) {
    console.error("revokeExemption error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to revoke tax exemption.", requestId);
  }
};

// ---- Tax Reporting ----

export const generateTaxReport = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.tax.manage")) return sendError(res, 403, "Permission denied.", requestId);
    const userId = req.auth?.userId || req.auth?.id || null;

    const report = await TaxService.generateTaxReport(req.query, scope.tenantId, userId);
    return sendSuccess(res, 201, "Tax report generated successfully.", report, requestId);
  } catch (error) {
    console.error("generateTaxReport error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to generate tax report.", requestId);
  }
};

export const listTaxReports = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.tax.read", "finance.read")) return sendError(res, 403, "Permission denied.", requestId);

    const items = await TaxService.listTaxReports(req.query, scope.tenantId);
    return sendSuccess(res, 200, "Tax reports retrieved successfully.", { items }, requestId);
  } catch (error) {
    console.error("listTaxReports error:", error);
    return sendError(res, 500, error.message || "Failed to retrieve tax reports.", requestId);
  }
};
