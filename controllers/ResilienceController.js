import { listDeadLetters, getDeadLetterById, listCircuitBreakers, markDeadLetterPermanentFailure } from "../utils/resilienceEngine.js";
import { sendSuccess, sendError } from "../utils/apiResponse.js";
import { createRequestId } from "../utils/authTokens.js";
import { getAccessScope } from "../utils/accessScope.js";

const hasPermission = (req, ...keys) => {
  const permissions = req.auth?.permissions || [];
  return permissions.includes("admin") || keys.some((key) => permissions.includes(key));
};

const statusFromError = (error) => {
  const message = error.message || "";
  if (message.includes("not found")) return 404;
  if (message.includes("required")) return 400;
  return 500;
};

const userIdOf = (req) => req.auth?.userId || req.auth?.id || null;

// Enterprise Resilience & Reliability Standard (Enterprise Architecture
// Hardening Phase, Improvement 6). Read-only DLQ/Circuit-Breaker
// visibility for the "Monitoring... Dashboard should expose all these
// metrics" requirement, plus the one deliberate manual DLQ action a
// generic HTTP API CAN safely expose (marking a record as a permanent,
// given-up failure). Actual DLQ *reprocessing* (`reprocessDeadLetter`)
// needs a real, per-integration executor function only that integration's
// own module knows how to run — not exposed generically here, see
// docs/07-enterprise-standards/06-resilience.md "Adoption".

export const listDeadLetterQueue = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "resilience.read")) return sendError(res, 403, "Permission denied.", requestId);

    const result = await listDeadLetters(scope.tenantId, req.query);
    return sendSuccess(res, 200, "Dead letter queue retrieved successfully.", result, requestId);
  } catch (error) {
    console.error("listDeadLetterQueue error:", error);
    return sendError(res, 500, error.message || "Failed to retrieve dead letter queue.", requestId);
  }
};

export const getDeadLetter = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "resilience.read")) return sendError(res, 403, "Permission denied.", requestId);

    const dlq = await getDeadLetterById(scope.tenantId, req.params.dlqId);
    return sendSuccess(res, 200, "Dead letter queue record retrieved successfully.", dlq, requestId);
  } catch (error) {
    console.error("getDeadLetter error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to retrieve dead letter queue record.", requestId);
  }
};

export const permanentlyFailDeadLetter = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "resilience.manage")) return sendError(res, 403, "Permission denied.", requestId);

    await getDeadLetterById(scope.tenantId, req.params.dlqId); // ownership check before mutating
    const dlq = await markDeadLetterPermanentFailure(req.params.dlqId, req.body?.reason, userIdOf(req));
    return sendSuccess(res, 200, "Dead letter queue record marked as a permanent failure.", dlq, requestId);
  } catch (error) {
    console.error("permanentlyFailDeadLetter error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to update dead letter queue record.", requestId);
  }
};

export const listCircuitBreakerStatus = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "resilience.read")) return sendError(res, 403, "Permission denied.", requestId);

    const breakers = await listCircuitBreakers();
    return sendSuccess(res, 200, "Circuit breaker status retrieved successfully.", { items: breakers }, requestId);
  } catch (error) {
    console.error("listCircuitBreakerStatus error:", error);
    return sendError(res, 500, error.message || "Failed to retrieve circuit breaker status.", requestId);
  }
};
