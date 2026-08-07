import AIAssistantService from "../services/AIAssistantService.js";
import AIAgentRegistry from "../services/ai/AIAgentRegistry.js";
import AISupervisorService from "../services/ai/AISupervisorService.js";
import { getAIAgentConfig } from "../utils/aiAgentConfig.js";
import { sendError, sendSuccess } from "../utils/apiResponse.js";
import { createRequestId } from "../utils/authTokens.js";

const AI_PERMISSION = "ai.assistant.use";

const buildContext = (req) => ({
  tenantId: req.auth?.tenantId || null,
  branchId: req.auth?.branchId || "main",
  userId: req.auth?.userId || req.auth?.id,
  userName: req.auth?.name || "User",
  permissions: req.auth?.permissions || [],
  role: req.auth?.role || req.auth?.roles?.[0] || ""
});

const hasAIAccess = (permissions) => permissions.includes(AI_PERMISSION) || permissions.includes("admin");
const hasAgentManageAccess = (permissions) => {
  const { managePermission } = getAIAgentConfig();
  return permissions.includes(managePermission) || permissions.includes("admin");
};

/**
 * Shared handler factory for every /ai/* endpoint — each is a thin
 * wrapper around AIAssistantService.chat with an optional forced tool
 * hint, matching "AI Tool Routing" in the doc (a dedicated endpoint biases
 * tool selection toward its own named capability rather than duplicating
 * the whole pipeline).
 */
const handleChat = (forcedToolName, defaultMode = "Assistant") => async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const ctx = buildContext(req);
    if (!ctx.tenantId) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasAIAccess(ctx.permissions)) {
      return sendError(res, 403, "Permission denied.", requestId);
    }
    if (!ctx.tenantId || !ctx.userId) {
      return sendError(res, 403, "Tenant and user context are required.", requestId);
    }

    const { message, conversationId, mode } = req.body;
    if (!message) {
      return sendError(res, 400, "message is required.", requestId);
    }

    const result = await AIAssistantService.chat({
      ...ctx,
      message,
      conversationId: conversationId || null,
      mode: mode || defaultMode,
      forcedToolName,
      requestId
    });

    return sendSuccess(res, 200, "AI response generated successfully.", result, requestId);
  } catch (err) {
    console.error("AIAssistantController Error:", err);
    const statusCode = err.code === "AI_UNAVAILABLE" ? 503 : err.message?.includes("required") || err.message?.includes("exceeds") ? 400 : 500;
    return sendError(res, statusCode, err.message || "Failed to process AI request.", requestId);
  }
};

/** 1. POST /api/v1/ai/chat — general conversational entry point. */
export const AIChat = handleChat(null, "Assistant");

/** 2. POST /api/v1/ai/flight-search */
export const AIFlightSearch = handleChat("flight_search", "Assistant");

/** 3. POST /api/v1/ai/hotel-search */
export const AIHotelSearch = handleChat("hotel_search", "Assistant");

/** 4. POST /api/v1/ai/package-search — combined flight+hotel planning, tool selection left to the model. */
export const AIPackageSearch = handleChat(null, "Assistant");

/** 5. POST /api/v1/ai/travel-plan — multi-step planning (doc's "Plan Umrah for six adults" example). */
export const AITravelPlan = handleChat(null, "Assistant");

/** 6. POST /api/v1/ai/dashboard */
export const AIDashboard = handleChat("get_operations_dashboard", "Operations");

/** 7. POST /api/v1/ai/analytics */
export const AIAnalytics = handleChat("get_revenue_dashboard", "Management");

/** 8. POST /api/v1/ai/search */
export const AISearch = handleChat("enterprise_search", "Assistant");

/** 9. POST /api/v1/ai/explain — fare rules / visa requirements explanation. */
export const AIExplain = handleChat(null, "Support");

/** 10. POST /api/v1/ai/summarize */
export const AISummarize = handleChat(null, "Assistant");

/** 11. POST /api/v1/ai/recommend */
export const AIRecommend = handleChat(null, "Assistant");

/** 12. GET /api/v1/ai/conversations */
export const ListAIConversations = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const ctx = buildContext(req);
    if (!ctx.tenantId) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasAIAccess(ctx.permissions)) {
      return sendError(res, 403, "Permission denied.", requestId);
    }
    const result = await AIAssistantService.listConversations({ tenantId: ctx.tenantId, userId: ctx.userId, page: req.query.page, pageSize: req.query.pageSize });
    return sendSuccess(res, 200, "AI conversations retrieved successfully.", result, requestId);
  } catch (err) {
    console.error("ListAIConversations Error:", err);
    return sendError(res, 500, err.message || "Failed to retrieve conversations.", requestId);
  }
};

/** POST /api/v1/ai/conversations/:conversationId/archive — completes the "Conversation → ... → Archive" memory lifecycle. */
export const ArchiveAIConversation = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const ctx = buildContext(req);
    if (!ctx.tenantId) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasAIAccess(ctx.permissions)) {
      return sendError(res, 403, "Permission denied.", requestId);
    }
    const conversation = await AIAssistantService.archiveConversation({ tenantId: ctx.tenantId, userId: ctx.userId, conversationId: req.params.conversationId });
    return sendSuccess(res, 200, "Conversation archived successfully.", { conversationId: conversation._id, status: conversation.status, summary: conversation.summary }, requestId);
  } catch (err) {
    console.error("ArchiveAIConversation Error:", err);
    return sendError(res, err.message?.includes("not found") ? 404 : 500, err.message || "Failed to archive conversation.", requestId);
  }
};

/** EXT-027 §16 "Manual clear supported". GET /api/v1/ai/conversations/:conversationId/context — read-only inspection of this session's remembered flight/hotel/passenger/booking context. */
export const GetAIConversationContext = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const ctx = buildContext(req);
    if (!ctx.tenantId) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasAIAccess(ctx.permissions)) return sendError(res, 403, "Permission denied.", requestId);
    const context = await AIAssistantService.getContext({ tenantId: ctx.tenantId, userId: ctx.userId, conversationId: req.params.conversationId });
    return sendSuccess(res, 200, "AI conversation context retrieved successfully.", context, requestId);
  } catch (err) {
    console.error("GetAIConversationContext Error:", err);
    return sendError(res, err.message?.includes("not found") ? 404 : 500, err.message || "Failed to retrieve conversation context.", requestId);
  }
};

/** POST /api/v1/ai/conversations/:conversationId/context/clear */
export const ClearAIConversationContext = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const ctx = buildContext(req);
    if (!ctx.tenantId) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasAIAccess(ctx.permissions)) return sendError(res, 403, "Permission denied.", requestId);
    const conversation = await AIAssistantService.clearContext({ tenantId: ctx.tenantId, userId: ctx.userId, conversationId: req.params.conversationId });
    return sendSuccess(res, 200, "AI conversation context cleared successfully.", { conversationId: conversation._id, context: conversation.context }, requestId);
  } catch (err) {
    console.error("ClearAIConversationContext Error:", err);
    return sendError(res, err.message?.includes("not found") ? 404 : 500, err.message || "Failed to clear conversation context.", requestId);
  }
};

/** GET /api/v1/ai/providers/status */
export const GetAIProviderStatus = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const ctx = buildContext(req);
    if (!ctx.tenantId) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasAIAccess(ctx.permissions)) {
      return sendError(res, 403, "Permission denied.", requestId);
    }
    const statusData = await AIAssistantService.getProviderStatus();
    return sendSuccess(res, 200, "AI provider status retrieved successfully.", statusData, requestId);
  } catch (err) {
    console.error("GetAIProviderStatus Error:", err);
    return sendError(res, 500, err.message || "Failed to check AI provider status.", requestId);
  }
};

/** EXT-035 §9 "Agent Discovery". GET /api/v1/ai/agents — the real agent registry, each agent's own real tool subset for the caller's actual permissions, real (never fabricated) recent health score, and its real, tenant-resolved §21 lifecycle state. */
export const GetAIAgents = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const ctx = buildContext(req);
    if (!ctx.tenantId) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasAIAccess(ctx.permissions)) {
      return sendError(res, 403, "Permission denied.", requestId);
    }
    const agents = await Promise.all(AIAgentRegistry.list().map(async (agent) => {
      const state = await AIAgentRegistry.getEffectiveState(agent.agentId, ctx.tenantId);
      return {
        agentId: agent.agentId,
        name: agent.name,
        description: agent.description,
        capabilities: agent.capabilities,
        version: agent.version,
        effectiveStatus: state.status,
        effectivePriority: state.priority,
        availableTools: AIAgentRegistry.getToolsForAgent(agent.agentId, ctx.permissions).map((t) => t.name),
        health: await AIAgentRegistry.getHealthScore(agent.agentId, { tenantId: ctx.tenantId })
      };
    }));
    return sendSuccess(res, 200, "AI agents retrieved successfully.", agents, requestId);
  } catch (err) {
    console.error("GetAIAgents Error:", err);
    return sendError(res, 500, err.message || "Failed to retrieve AI agents.", requestId);
  }
};

/** EXT-035 §21 "Agent Lifecycle." PATCH /api/v1/ai/agents/:agentId/state — a real, tenant-scoped, DB-persisted transition, never mutating the static registry. */
export const TransitionAgentState = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const ctx = buildContext(req);
    if (!ctx.tenantId) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasAgentManageAccess(ctx.permissions)) return sendError(res, 403, "Permission denied.", requestId);
    const { status, priority, reason } = req.body;
    if (!status) return sendError(res, 400, "status is required.", requestId);
    const state = await AIAgentRegistry.transitionState({ tenantId: ctx.tenantId, userId: ctx.userId, agentId: req.params.agentId, status, priority, reason });
    return sendSuccess(res, 200, `Agent '${req.params.agentId}' transitioned to '${status}'.`, state, requestId);
  } catch (err) {
    console.error("TransitionAgentState Error:", err);
    return sendError(res, err.message?.includes("Unknown agentId") ? 404 : err.message?.includes("must be one of") ? 400 : 500, err.message || "Failed to transition agent state.", requestId);
  }
};

/**
 * EXT-035 §6/§13 "Supervisor Agent ... Agent Collaboration." POST
 * /api/v1/ai/supervisor — dynamically decides which specialized agent(s)
 * are relevant and, for a genuinely multi-capability request, runs them in
 * real parallel and merges their results. A request needing 0 or 1 agents
 * transparently reuses the existing /ai/chat pipeline (see
 * `supervisorDecision.coordinated: false` in the response) — this endpoint
 * is additive, not a replacement for the simpler single-pass /ai/chat.
 */
export const AISupervisorChat = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const ctx = buildContext(req);
    if (!ctx.tenantId) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasAIAccess(ctx.permissions)) return sendError(res, 403, "Permission denied.", requestId);
    if (!ctx.tenantId || !ctx.userId) return sendError(res, 403, "Tenant and user context are required.", requestId);

    const { message, conversationId, mode } = req.body;
    if (!message) return sendError(res, 400, "message is required.", requestId);

    const result = await AISupervisorService.coordinate({ ...ctx, message, conversationId: conversationId || null, mode: mode || "Assistant", requestId });
    return sendSuccess(res, 200, "AI supervisor response generated successfully.", result, requestId);
  } catch (err) {
    console.error("AISupervisorChat Error:", err);
    const statusCode = err.code === "AI_UNAVAILABLE" ? 503 : err.message?.includes("required") || err.message?.includes("exceeds") ? 400 : 500;
    return sendError(res, statusCode, err.message || "Failed to process AI supervisor request.", requestId);
  }
};
