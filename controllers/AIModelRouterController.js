import AIModelRouterService from "../services/ai/AIModelRouterService.js";
import AIAssistantService from "../services/AIAssistantService.js";
import { getAIModelConfig } from "../utils/aiModelConfig.js";
import { sendError, sendSuccess } from "../utils/apiResponse.js";
import { createRequestId } from "../utils/authTokens.js";

const AI_PERMISSION = "ai.assistant.use";

const buildContext = (req) => ({
  tenantId: req.auth?.tenantId || null,
  userId: req.auth?.userId || req.auth?.id,
  permissions: req.auth?.permissions || []
});

const hasAIAccess = (permissions) => permissions.includes(AI_PERMISSION) || permissions.includes("admin");
const hasModelManageAccess = (permissions) => {
  const { managePermission } = getAIModelConfig();
  return permissions.includes(managePermission) || permissions.includes("admin");
};
// Provider health/config and shadow-test content are cross-tenant
// operational data, same gating as AIObservabilityController's dashboards.
const hasAdminAccess = (permissions) => permissions.includes("admin");

/** 1. GET /api/v1/ai/models/catalog — §12/§13 real model registry. */
export const GetModelCatalog = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const ctx = buildContext(req);
    if (!ctx.tenantId) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasAIAccess(ctx.permissions)) return sendError(res, 403, "Permission denied.", requestId);
    return sendSuccess(res, 200, "AI model catalog retrieved successfully.", AIModelRouterService.getModelCatalog(), requestId);
  } catch (err) {
    console.error("GetModelCatalog Error:", err);
    return sendError(res, 500, err.message || "Failed to retrieve model catalog.", requestId);
  }
};

/** 2. GET /api/v1/ai/models/providers/health — §11 "Provider Health." Admin-only: reveals real circuit-breaker/failure state, same class of operational signal as AIObservabilityController's provider dashboard. */
export const GetProviderHealth = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const ctx = buildContext(req);
    if (!ctx.tenantId) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasAdminAccess(ctx.permissions)) return sendError(res, 403, "Permission denied.", requestId);
    const status = await AIAssistantService.getProviderStatus();
    return sendSuccess(res, 200, "AI provider health retrieved successfully.", status, requestId);
  } catch (err) {
    console.error("GetProviderHealth Error:", err);
    return sendError(res, 500, err.message || "Failed to retrieve provider health.", requestId);
  }
};

/** 3. POST /api/v1/ai/models/routing-policies — §9/§14 upsert (one active policy per tenant+category). */
export const UpsertRoutingPolicy = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const ctx = buildContext(req);
    if (!ctx.tenantId) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasModelManageAccess(ctx.permissions)) return sendError(res, 403, "Permission denied.", requestId);
    const { category, preferredProviders, costOptimized, shadowProvider, shadowModel, isActive } = req.body;
    const policy = await AIModelRouterService.upsertRoutingPolicy({ tenantId: ctx.tenantId, userId: ctx.userId, category, preferredProviders, costOptimized, shadowProvider, shadowModel, isActive });
    return sendSuccess(res, 200, "AI routing policy saved successfully.", policy, requestId);
  } catch (err) {
    console.error("UpsertRoutingPolicy Error:", err);
    return sendError(res, err.message?.includes("required") || err.message?.includes("Unknown") ? 400 : 500, err.message || "Failed to save routing policy.", requestId);
  }
};

/** 4. GET /api/v1/ai/models/routing-policies */
export const ListRoutingPolicies = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const ctx = buildContext(req);
    if (!ctx.tenantId) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasAIAccess(ctx.permissions)) return sendError(res, 403, "Permission denied.", requestId);
    const policies = await AIModelRouterService.listRoutingPolicies({ tenantId: ctx.tenantId });
    return sendSuccess(res, 200, "AI routing policies retrieved successfully.", policies, requestId);
  } catch (err) {
    console.error("ListRoutingPolicies Error:", err);
    return sendError(res, 500, err.message || "Failed to list routing policies.", requestId);
  }
};

/** 5. DELETE /api/v1/ai/models/routing-policies/:category */
export const DeleteRoutingPolicy = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const ctx = buildContext(req);
    if (!ctx.tenantId) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasModelManageAccess(ctx.permissions)) return sendError(res, 403, "Permission denied.", requestId);
    const policy = await AIModelRouterService.deleteRoutingPolicy({ tenantId: ctx.tenantId, category: req.params.category });
    return sendSuccess(res, 200, "AI routing policy deleted successfully.", policy, requestId);
  } catch (err) {
    console.error("DeleteRoutingPolicy Error:", err);
    return sendError(res, err.message?.includes("not found") ? 404 : 500, err.message || "Failed to delete routing policy.", requestId);
  }
};

/** 6. POST /api/v1/ai/models/ab-tests — §16 */
export const CreateABTest = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const ctx = buildContext(req);
    if (!ctx.tenantId) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasModelManageAccess(ctx.permissions)) return sendError(res, 403, "Permission denied.", requestId);
    const { category, name, description, variantA, variantB, trafficSplitPct } = req.body;
    const test = await AIModelRouterService.createABTest({ tenantId: ctx.tenantId, userId: ctx.userId, category, name, description, variantA, variantB, trafficSplitPct });
    return sendSuccess(res, 201, "AI A/B test created successfully.", test, requestId);
  } catch (err) {
    console.error("CreateABTest Error:", err);
    return sendError(res, err.message?.includes("required") || err.message?.includes("must be") ? 400 : 500, err.message || "Failed to create A/B test.", requestId);
  }
};

/** 7. POST /api/v1/ai/models/ab-tests/:testId/start */
export const StartABTest = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const ctx = buildContext(req);
    if (!ctx.tenantId) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasModelManageAccess(ctx.permissions)) return sendError(res, 403, "Permission denied.", requestId);
    const test = await AIModelRouterService.startABTest({ tenantId: ctx.tenantId, testId: req.params.testId });
    return sendSuccess(res, 200, "AI A/B test started successfully.", test, requestId);
  } catch (err) {
    console.error("StartABTest Error:", err);
    return sendError(res, err.message?.includes("not found") ? 404 : err.message?.includes("Cannot start") || err.message?.includes("already running") ? 409 : 500, err.message || "Failed to start A/B test.", requestId);
  }
};

/** 8. POST /api/v1/ai/models/ab-tests/:testId/cancel */
export const CancelABTest = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const ctx = buildContext(req);
    if (!ctx.tenantId) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasModelManageAccess(ctx.permissions)) return sendError(res, 403, "Permission denied.", requestId);
    const test = await AIModelRouterService.cancelABTest({ tenantId: ctx.tenantId, testId: req.params.testId });
    return sendSuccess(res, 200, "AI A/B test cancelled successfully.", test, requestId);
  } catch (err) {
    console.error("CancelABTest Error:", err);
    return sendError(res, err.message?.includes("not found") ? 404 : err.message?.includes("Cannot cancel") ? 409 : 500, err.message || "Failed to cancel A/B test.", requestId);
  }
};

/** 9. GET /api/v1/ai/models/ab-tests */
export const ListABTests = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const ctx = buildContext(req);
    if (!ctx.tenantId) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasAIAccess(ctx.permissions)) return sendError(res, 403, "Permission denied.", requestId);
    const result = await AIModelRouterService.listABTests({ tenantId: ctx.tenantId, category: req.query.category, status: req.query.status, page: req.query.page, pageSize: req.query.pageSize });
    return sendSuccess(res, 200, "AI A/B tests retrieved successfully.", result, requestId);
  } catch (err) {
    console.error("ListABTests Error:", err);
    return sendError(res, 500, err.message || "Failed to list A/B tests.", requestId);
  }
};

/** 10. GET /api/v1/ai/models/ab-tests/:testId/results — real per-variant metrics aggregated from AIRequestMetricModel. */
export const GetABTestResults = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const ctx = buildContext(req);
    if (!ctx.tenantId) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasAIAccess(ctx.permissions)) return sendError(res, 403, "Permission denied.", requestId);
    const result = await AIModelRouterService.getABTestResults({ tenantId: ctx.tenantId, testId: req.params.testId });
    return sendSuccess(res, 200, "AI A/B test results retrieved successfully.", result, requestId);
  } catch (err) {
    console.error("GetABTestResults Error:", err);
    return sendError(res, err.message?.includes("not found") ? 404 : 500, err.message || "Failed to retrieve A/B test results.", requestId);
  }
};

/** 11. POST /api/v1/ai/models/ab-tests/:testId/promote — §16 "Winner promoted automatically after approval" — this IS the approval; always an explicit human call, never autonomous. */
export const PromoteABTestWinner = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const ctx = buildContext(req);
    if (!ctx.tenantId) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasModelManageAccess(ctx.permissions)) return sendError(res, 403, "Permission denied.", requestId);
    const { winner } = req.body;
    if (!winner) return sendError(res, 400, "winner ('A' or 'B') is required.", requestId);
    const test = await AIModelRouterService.promoteABTestWinner({ tenantId: ctx.tenantId, userId: ctx.userId, testId: req.params.testId, winner });
    return sendSuccess(res, 200, `A/B test winner (Variant ${winner}) promoted successfully.`, test, requestId);
  } catch (err) {
    console.error("PromoteABTestWinner Error:", err);
    return sendError(res, err.message?.includes("not found") ? 404 : err.message?.includes("Cannot promote") ? 409 : 400, err.message || "Failed to promote A/B test winner.", requestId);
  }
};

/** 12. GET /api/v1/ai/models/shadow-tests — §17. Admin-only: shadow content excerpts are internal evaluation data, not general AI-access-scope data. */
export const ListShadowTestResults = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const ctx = buildContext(req);
    if (!ctx.tenantId) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasAdminAccess(ctx.permissions)) return sendError(res, 403, "Permission denied.", requestId);
    const result = await AIModelRouterService.listShadowTestResults({ tenantId: ctx.tenantId, category: req.query.category, page: req.query.page, pageSize: req.query.pageSize });
    return sendSuccess(res, 200, "AI shadow test results retrieved successfully.", result, requestId);
  } catch (err) {
    console.error("ListShadowTestResults Error:", err);
    return sendError(res, 500, err.message || "Failed to list shadow test results.", requestId);
  }
};
