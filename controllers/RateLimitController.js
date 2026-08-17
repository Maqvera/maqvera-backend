import { registerRateLimitRule, listRateLimitRules } from "../utils/rateLimitRules.js";
import RateLimitViolationModel from "../models/RateLimitViolationModel.js";
import { getRateLimitConfig } from "../utils/rateLimitConfig.js";
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
  if (message.includes("already exists")) return 409;
  if (message.includes("required") || message.includes("Invalid") || message.includes("must be")) return 400;
  return 500;
};

const userIdOf = (req) => req.auth?.userId || req.auth?.id || null;

// Enterprise API Rate Limiting & Throttling Standard (Enterprise
// Architecture Hardening Phase, Improvement 13). Real rule management +
// the "Monitoring — Top Consumers, Rate Limit Violations, Blocked
// Requests" read surface, following the exact same thin-controller
// pattern as controllers/ResilienceController.js (Improvement 6) and
// controllers/ApiVersionController.js (Improvement 8).

export const createOrUpdateRateLimitRule = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "ratelimit.manage")) return sendError(res, 403, "Permission denied.", requestId);

    const { scope: ruleScope, ruleKey = null, limit, windowSeconds, priority, owner, description, tenantWide } = req.body || {};
    if (!ruleScope) return sendError(res, 400, "scope is required.", requestId);

    const targetTenantId = tenantWide && hasPermission(req, "admin") ? null : scope.tenantId;
    const rule = await registerRateLimitRule(targetTenantId, ruleScope, ruleKey, { limit, windowSeconds, priority, owner, description, userId: userIdOf(req) });
    return sendSuccess(res, 200, "Rate limit rule saved successfully.", rule, requestId);
  } catch (error) {
    console.error("createOrUpdateRateLimitRule error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to save rate limit rule.", requestId);
  }
};

export const listRateLimitRulesHandler = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "ratelimit.read")) return sendError(res, 403, "Permission denied.", requestId);

    const result = await listRateLimitRules({ ...req.query, tenantId: scope.tenantId });
    return sendSuccess(res, 200, "Rate limit rules retrieved successfully.", result, requestId);
  } catch (error) {
    console.error("listRateLimitRulesHandler error:", error);
    return sendError(res, 500, error.message || "Failed to retrieve rate limit rules.", requestId);
  }
};

export const listRateLimitViolations = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "ratelimit.read")) return sendError(res, 403, "Permission denied.", requestId);

    const config = getRateLimitConfig();
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const pageSize = Math.min(Math.max(parseInt(req.query.pageSize, 10) || config.defaultPageSize, 1), config.maxPageSize);
    const filter = { tenantId: scope.tenantId };
    if (req.query.scope) filter.scope = req.query.scope;
    if (req.query.identifier) filter.identifier = req.query.identifier;

    const [items, total] = await Promise.all([
      RateLimitViolationModel.find(filter).sort({ occurredAt: -1 }).skip((page - 1) * pageSize).limit(pageSize).lean(),
      RateLimitViolationModel.countDocuments(filter)
    ]);
    return sendSuccess(res, 200, "Rate limit violations retrieved successfully.", { items, pagination: { total, page, pageSize, totalPages: Math.ceil(total / pageSize) } }, requestId);
  } catch (error) {
    console.error("listRateLimitViolations error:", error);
    return sendError(res, 500, error.message || "Failed to retrieve rate limit violations.", requestId);
  }
};

export const getRateLimitTopConsumers = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "ratelimit.read")) return sendError(res, 403, "Permission denied.", requestId);

    const since = new Date(Date.now() - (parseInt(req.query.windowMinutes, 10) || 60) * 60 * 1000);
    const topConsumers = await RateLimitViolationModel.aggregate([
      { $match: { tenantId: scope.tenantId, occurredAt: { $gte: since } } },
      { $group: { _id: { scope: "$scope", identifier: "$identifier" }, violations: { $sum: 1 }, lastViolationAt: { $max: "$occurredAt" } } },
      { $sort: { violations: -1 } },
      { $limit: 20 }
    ]);
    return sendSuccess(res, 200, "Top rate limit consumers retrieved successfully.", { items: topConsumers }, requestId);
  } catch (error) {
    console.error("getRateLimitTopConsumers error:", error);
    return sendError(res, 500, error.message || "Failed to retrieve top consumers.", requestId);
  }
};
