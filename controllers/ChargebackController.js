import ChargebackService from "../services/ChargebackService.js";
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

export const listChargebacks = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.chargeback.read", "finance.read")) return sendError(res, 403, "Permission denied.", requestId);

    const result = await ChargebackService.listChargebacks(req.query, scope.tenantId);
    return sendSuccess(res, 200, "Chargebacks retrieved successfully.", result, requestId);
  } catch (error) {
    console.error("listChargebacks error:", error);
    return sendError(res, 500, error.message || "Failed to retrieve chargebacks.", requestId);
  }
};

export const getChargeback = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.chargeback.read", "finance.read")) return sendError(res, 403, "Permission denied.", requestId);

    const chargeback = await ChargebackService.getChargebackById(req.params.chargebackId, scope.tenantId);
    return sendSuccess(res, 200, "Chargeback retrieved successfully.", chargeback, requestId);
  } catch (error) {
    console.error("getChargeback error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to retrieve chargeback.", requestId);
  }
};

export const createChargeback = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.chargeback.create")) return sendError(res, 403, "Permission denied.", requestId);
    const userId = req.auth?.userId || req.auth?.id || null;

    const chargeback = await ChargebackService.createChargeback(req.body, scope.tenantId, userId);
    return sendSuccess(res, 201, "Chargeback created successfully.", chargeback, requestId);
  } catch (error) {
    console.error("createChargeback error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to create chargeback.", requestId);
  }
};

export const submitChargebackEvidence = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.chargeback.manage")) return sendError(res, 403, "Permission denied.", requestId);
    const userId = req.auth?.userId || req.auth?.id || null;

    const chargeback = await ChargebackService.submitEvidence(req.params.chargebackId, req.body, scope.tenantId, userId);
    return sendSuccess(res, 200, "Evidence submitted successfully.", chargeback, requestId);
  } catch (error) {
    console.error("submitChargebackEvidence error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to submit evidence.", requestId);
  }
};

export const resolveChargeback = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.chargeback.manage")) return sendError(res, 403, "Permission denied.", requestId);
    const userId = req.auth?.userId || req.auth?.id || null;

    const chargeback = await ChargebackService.resolveChargeback(req.params.chargebackId, req.body, scope.tenantId, userId);
    return sendSuccess(res, 200, "Chargeback resolved successfully.", chargeback, requestId);
  } catch (error) {
    console.error("resolveChargeback error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to resolve chargeback.", requestId);
  }
};
