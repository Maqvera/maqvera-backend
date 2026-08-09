import AIObservabilityService from "../services/ai/AIObservabilityService.js";
import AIAssistantService from "../services/AIAssistantService.js";
import AIOrchestrationService from "../services/AIOrchestrationService.js";
import { getAIObservabilityConfig } from "../utils/aiObservabilityConfig.js";
import { sendError, sendSuccess } from "../utils/apiResponse.js";
import { createRequestId } from "../utils/authTokens.js";

const buildContext = (req) => ({
  tenantId: req.auth?.tenantId || null,
  userId: req.auth?.userId || req.auth?.id,
  permissions: req.auth?.permissions || []
});

// Every dashboard/metrics endpoint here surfaces cross-cutting operational/
// cost/security data for the whole tenant (not scoped to the calling
// user), same reasoning GetWorkflowMetrics/GetGuardrailMetrics already
// apply — admin-only, not merely the general ai.assistant.use permission.
const hasAdminAccess = (permissions) => permissions.includes("admin");
// The one non-read action (manually triggering alert evaluation) is a
// narrower, operational trigger rather than raw data exposure — a
// dedicated ai.observability.manage permission can be granted for it
// without handing out full admin.
const hasObservabilityManageAccess = (permissions) => {
  const { managePermission } = getAIObservabilityConfig();
  return permissions.includes(managePermission) || permissions.includes("admin");
};

const parseRange = (req) => ({ from: req.query.from || null, to: req.query.to || null });

/**
 * Gathers real provider/circuit-breaker status from BOTH AI entry points
 * (chat and orchestration each keep their own CircuitBreaker instance) —
 * deliberately done here, in the controller, rather than inside
 * AIObservabilityService itself, to avoid a circular module dependency
 * (see AIObservabilityService's own docblock).
 */
const gatherProviderStatus = async () => {
  const [chatStatus, orchestrationStatus] = await Promise.all([AIAssistantService.getProviderStatus(), AIOrchestrationService.getProviderStatus()]);
  return { ...chatStatus, ...orchestrationStatus };
};

/** 1. GET /api/v1/ai/observability/requests — §6 */
export const GetRequestMetrics = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const ctx = buildContext(req);
    if (!ctx.tenantId) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasAdminAccess(ctx.permissions)) return sendError(res, 403, "Permission denied.", requestId);
    const metrics = await AIObservabilityService.getRequestMetrics({ tenantId: ctx.tenantId, ...parseRange(req) });
    return sendSuccess(res, 200, "AI request metrics retrieved successfully.", metrics, requestId);
  } catch (err) {
    console.error("GetRequestMetrics Error:", err);
    return sendError(res, 500, err.message || "Failed to retrieve request metrics.", requestId);
  }
};

/** 2. GET /api/v1/ai/observability/llm — §7 */
export const GetLLMMetrics = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const ctx = buildContext(req);
    if (!ctx.tenantId) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasAdminAccess(ctx.permissions)) return sendError(res, 403, "Permission denied.", requestId);
    const metrics = await AIObservabilityService.getLLMMetrics({ tenantId: ctx.tenantId, ...parseRange(req) });
    return sendSuccess(res, 200, "AI LLM metrics retrieved successfully.", metrics, requestId);
  } catch (err) {
    console.error("GetLLMMetrics Error:", err);
    return sendError(res, 500, err.message || "Failed to retrieve LLM metrics.", requestId);
  }
};

/** 3. GET /api/v1/ai/observability/tools — §8 */
export const GetToolMetrics = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const ctx = buildContext(req);
    if (!ctx.tenantId) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasAdminAccess(ctx.permissions)) return sendError(res, 403, "Permission denied.", requestId);
    const metrics = await AIObservabilityService.getToolMetrics({ tenantId: ctx.tenantId, ...parseRange(req) });
    return sendSuccess(res, 200, "AI tool metrics retrieved successfully.", metrics, requestId);
  } catch (err) {
    console.error("GetToolMetrics Error:", err);
    return sendError(res, 500, err.message || "Failed to retrieve tool metrics.", requestId);
  }
};

/** 4. GET /api/v1/ai/observability/rag — §11 */
export const GetRAGMetrics = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const ctx = buildContext(req);
    if (!ctx.tenantId) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasAdminAccess(ctx.permissions)) return sendError(res, 403, "Permission denied.", requestId);
    const metrics = await AIObservabilityService.getRAGMetrics({ tenantId: ctx.tenantId, ...parseRange(req) });
    return sendSuccess(res, 200, "AI RAG metrics retrieved successfully.", metrics, requestId);
  } catch (err) {
    console.error("GetRAGMetrics Error:", err);
    return sendError(res, 500, err.message || "Failed to retrieve RAG metrics.", requestId);
  }
};

/** EXT-035 §20 "Agent Usage." GET /api/v1/ai/observability/agents — real, unified across the single-agent chat path and Supervisor-coordinated multi-agent turns. */
export const GetAgentMetrics = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const ctx = buildContext(req);
    if (!ctx.tenantId) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasAdminAccess(ctx.permissions)) return sendError(res, 403, "Permission denied.", requestId);
    const metrics = await AIObservabilityService.getAgentMetrics({ tenantId: ctx.tenantId, ...parseRange(req) });
    return sendSuccess(res, 200, "AI agent usage metrics retrieved successfully.", metrics, requestId);
  } catch (err) {
    console.error("GetAgentMetrics Error:", err);
    return sendError(res, 500, err.message || "Failed to retrieve agent usage metrics.", requestId);
  }
};

/** 5. GET /api/v1/ai/observability/memory — §12 */
export const GetMemoryMetrics = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const ctx = buildContext(req);
    if (!ctx.tenantId) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasAdminAccess(ctx.permissions)) return sendError(res, 403, "Permission denied.", requestId);
    const metrics = await AIObservabilityService.getMemoryMetrics({ tenantId: ctx.tenantId });
    return sendSuccess(res, 200, "AI memory metrics retrieved successfully.", metrics, requestId);
  } catch (err) {
    console.error("GetMemoryMetrics Error:", err);
    return sendError(res, 500, err.message || "Failed to retrieve memory metrics.", requestId);
  }
};

/** 6. GET /api/v1/ai/observability/quality — §13 */
export const GetQualityMetrics = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const ctx = buildContext(req);
    if (!ctx.tenantId) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasAdminAccess(ctx.permissions)) return sendError(res, 403, "Permission denied.", requestId);
    const metrics = await AIObservabilityService.getQualityMetrics({ tenantId: ctx.tenantId, ...parseRange(req) });
    return sendSuccess(res, 200, "AI quality metrics retrieved successfully.", metrics, requestId);
  } catch (err) {
    console.error("GetQualityMetrics Error:", err);
    return sendError(res, 500, err.message || "Failed to retrieve quality metrics.", requestId);
  }
};

/** 7. GET /api/v1/ai/observability/cost — §21 */
export const GetCostMetrics = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const ctx = buildContext(req);
    if (!ctx.tenantId) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasAdminAccess(ctx.permissions)) return sendError(res, 403, "Permission denied.", requestId);
    const metrics = await AIObservabilityService.getCostMetrics({ tenantId: ctx.tenantId, ...parseRange(req), groupBy: req.query.groupBy === "month" ? "month" : "day" });
    return sendSuccess(res, 200, "AI cost metrics retrieved successfully.", metrics, requestId);
  } catch (err) {
    console.error("GetCostMetrics Error:", err);
    return sendError(res, 500, err.message || "Failed to retrieve cost metrics.", requestId);
  }
};

/** 8. GET /api/v1/ai/observability/prompts — §10 */
export const GetPromptDashboard = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const ctx = buildContext(req);
    if (!ctx.tenantId) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasAdminAccess(ctx.permissions)) return sendError(res, 403, "Permission denied.", requestId);
    const dashboard = await AIObservabilityService.getPromptDashboard({ tenantId: ctx.tenantId });
    return sendSuccess(res, 200, "AI prompt dashboard retrieved successfully.", dashboard, requestId);
  } catch (err) {
    console.error("GetPromptDashboard Error:", err);
    return sendError(res, 500, err.message || "Failed to retrieve prompt dashboard.", requestId);
  }
};

/** 9. GET /api/v1/ai/observability/security — §23 */
export const GetSecurityMetrics = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const ctx = buildContext(req);
    if (!ctx.tenantId) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasAdminAccess(ctx.permissions)) return sendError(res, 403, "Permission denied.", requestId);
    const metrics = await AIObservabilityService.getSecurityMetrics({ tenantId: ctx.tenantId, ...parseRange(req) });
    return sendSuccess(res, 200, "AI security metrics retrieved successfully.", metrics, requestId);
  } catch (err) {
    console.error("GetSecurityMetrics Error:", err);
    return sendError(res, 500, err.message || "Failed to retrieve security metrics.", requestId);
  }
};

/** 10. GET /api/v1/ai/observability/providers — real circuit-breaker status merged from both AI entry points. */
export const GetProviderDashboard = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const ctx = buildContext(req);
    if (!ctx.tenantId) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasAdminAccess(ctx.permissions)) return sendError(res, 403, "Permission denied.", requestId);
    const providerStatus = await gatherProviderStatus();
    return sendSuccess(res, 200, "AI provider dashboard retrieved successfully.", providerStatus, requestId);
  } catch (err) {
    console.error("GetProviderDashboard Error:", err);
    return sendError(res, 500, err.message || "Failed to retrieve provider dashboard.", requestId);
  }
};

/** 11. GET /api/v1/ai/observability/health — §22 */
export const GetHealthScore = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const ctx = buildContext(req);
    if (!ctx.tenantId) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasAdminAccess(ctx.permissions)) return sendError(res, 403, "Permission denied.", requestId);
    const providerStatus = await gatherProviderStatus();
    const health = await AIObservabilityService.getHealthScore({ tenantId: ctx.tenantId, providerStatus });
    return sendSuccess(res, 200, "AI health score retrieved successfully.", health, requestId);
  } catch (err) {
    console.error("GetHealthScore Error:", err);
    return sendError(res, 500, err.message || "Failed to retrieve AI health score.", requestId);
  }
};

/** 12. GET /api/v1/ai/observability/dashboard/executive — §18 */
export const GetExecutiveDashboard = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const ctx = buildContext(req);
    if (!ctx.tenantId) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasAdminAccess(ctx.permissions)) return sendError(res, 403, "Permission denied.", requestId);
    const providerStatus = await gatherProviderStatus();
    const dashboard = await AIObservabilityService.getExecutiveDashboard({ tenantId: ctx.tenantId, providerStatus });
    return sendSuccess(res, 200, "AI executive dashboard retrieved successfully.", dashboard, requestId);
  } catch (err) {
    console.error("GetExecutiveDashboard Error:", err);
    return sendError(res, 500, err.message || "Failed to retrieve executive dashboard.", requestId);
  }
};

/** 13. GET /api/v1/ai/observability/alerts — §19 */
export const ListAlerts = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const ctx = buildContext(req);
    if (!ctx.tenantId) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasAdminAccess(ctx.permissions)) return sendError(res, 403, "Permission denied.", requestId);
    const result = await AIObservabilityService.listAlerts({ tenantId: ctx.tenantId, status: req.query.status, page: req.query.page, pageSize: req.query.pageSize });
    return sendSuccess(res, 200, "AI alerts retrieved successfully.", result, requestId);
  } catch (err) {
    console.error("ListAlerts Error:", err);
    return sendError(res, 500, err.message || "Failed to retrieve AI alerts.", requestId);
  }
};

/** 14. POST /api/v1/ai/observability/alerts/evaluate — real, on-demand alert evaluation (the same check the scheduler runs on a cron), useful for testing thresholds without waiting for the next sweep. */
export const EvaluateAlerts = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const ctx = buildContext(req);
    if (!ctx.tenantId) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasObservabilityManageAccess(ctx.permissions)) return sendError(res, 403, "Permission denied.", requestId);
    const providerStatus = await gatherProviderStatus();
    const result = await AIObservabilityService.evaluateAlerts({ tenantId: ctx.tenantId, providerStatus });
    return sendSuccess(res, 200, "AI alert evaluation completed.", result, requestId);
  } catch (err) {
    console.error("EvaluateAlerts Error:", err);
    return sendError(res, 500, err.message || "Failed to evaluate AI alerts.", requestId);
  }
};
