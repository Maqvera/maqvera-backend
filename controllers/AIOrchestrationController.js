import AIOrchestrationService from "../services/AIOrchestrationService.js";
import { sendError, sendSuccess } from "../utils/apiResponse.js";
import { createRequestId } from "../utils/authTokens.js";

const AI_PERMISSION = "ai.assistant.use";

const buildContext = (req) => ({
  tenantId: req.auth?.tenantId || null,
  userId: req.auth?.userId || req.auth?.id,
  userName: req.auth?.name || "User",
  permissions: req.auth?.permissions || [],
  role: req.auth?.role || req.auth?.roles?.[0] || ""
});

const hasAIAccess = (permissions) => permissions.includes(AI_PERMISSION) || permissions.includes("admin");

/** 1. GET /api/v1/ai/tools — Tool Discovery. Supports ?format=mcp for the "MCP Ready" schema shape. */
export const ListTools = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const ctx = buildContext(req);
    if (!ctx.tenantId) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasAIAccess(ctx.permissions)) return sendError(res, 403, "Permission denied.", requestId);
    const tools = AIOrchestrationService.getToolCatalog(ctx.permissions, req.query.format);
    return sendSuccess(res, 200, "AI tool catalog retrieved successfully.", { tools }, requestId);
  } catch (err) {
    console.error("ListTools Error:", err);
    return sendError(res, 500, err.message || "Failed to list AI tools.", requestId);
  }
};

/** 2. GET /api/v1/ai/tools/:toolId */
export const GetToolById = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const ctx = buildContext(req);
    if (!ctx.tenantId) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasAIAccess(ctx.permissions)) return sendError(res, 403, "Permission denied.", requestId);
    const tool = AIOrchestrationService.getToolById(req.params.toolId, ctx.permissions);
    if (!tool) return sendError(res, 404, "Tool not found or not permitted for this user.", requestId);
    return sendSuccess(res, 200, "AI tool details retrieved successfully.", tool, requestId);
  } catch (err) {
    console.error("GetToolById Error:", err);
    return sendError(res, 500, err.message || "Failed to retrieve AI tool.", requestId);
  }
};

/** 3. POST /api/v1/ai/tools/validate — dry-run schema validation, no execution. */
export const ValidateToolCall = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const ctx = buildContext(req);
    if (!ctx.tenantId) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasAIAccess(ctx.permissions)) return sendError(res, 403, "Permission denied.", requestId);
    const { toolName, arguments: toolArguments } = req.body;
    if (!toolName) return sendError(res, 400, "toolName is required.", requestId);
    const result = AIOrchestrationService.validateToolCall(toolName, toolArguments);
    return sendSuccess(res, 200, "Tool call validated.", result, requestId);
  } catch (err) {
    console.error("ValidateToolCall Error:", err);
    return sendError(res, 500, err.message || "Failed to validate tool call.", requestId);
  }
};

/** 4. POST /api/v1/ai/tools/plan */
export const CreatePlan = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const ctx = buildContext(req);
    if (!ctx.tenantId) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasAIAccess(ctx.permissions)) return sendError(res, 403, "Permission denied.", requestId);
    if (!ctx.tenantId || !ctx.userId) return sendError(res, 403, "Tenant and user context are required.", requestId);
    const { prompt, conversationId } = req.body;
    if (!prompt) return sendError(res, 400, "prompt is required.", requestId);

    const plan = await AIOrchestrationService.createPlan({ tenantId: ctx.tenantId, userId: ctx.userId, userName: ctx.userName, role: ctx.role, permissions: ctx.permissions, prompt, conversationId: conversationId || null });
    return sendSuccess(res, 201, "Execution plan created. No tools have been executed yet.", plan, requestId);
  } catch (err) {
    console.error("CreatePlan Error:", err);
    const statusCode = err.code === "AI_UNAVAILABLE" ? 503 : err.message?.includes("required") || err.message?.includes("exceeds") || err.message?.includes("valid plan") ? 400 : 500;
    return sendError(res, statusCode, err.message || "Failed to create execution plan.", requestId);
  }
};

/** 5. POST /api/v1/ai/tools/execute */
export const ExecutePlan = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const ctx = buildContext(req);
    if (!ctx.tenantId) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasAIAccess(ctx.permissions)) return sendError(res, 403, "Permission denied.", requestId);
    const { executionId } = req.body;
    if (!executionId) return sendError(res, 400, "executionId is required.", requestId);

    const execution = await AIOrchestrationService.executePlan({ ...ctx, executionId, requestId });
    return sendSuccess(res, 200, "Execution plan processed.", execution, requestId);
  } catch (err) {
    console.error("ExecutePlan Error:", err);
    const statusCode = err.message?.includes("not found") ? 404 : err.message?.includes("already") ? 409 : err.code === "AI_UNAVAILABLE" ? 503 : 500;
    return sendError(res, statusCode, err.message || "Failed to execute plan.", requestId);
  }
};

/** EXT-028 §15 "Cancellation". POST /api/v1/ai/executions/:executionId/cancel */
export const CancelExecution = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const ctx = buildContext(req);
    if (!ctx.tenantId) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasAIAccess(ctx.permissions)) return sendError(res, 403, "Permission denied.", requestId);
    const execution = await AIOrchestrationService.cancelExecution({ tenantId: ctx.tenantId, userId: ctx.userId, executionId: req.params.executionId, reason: req.body?.reason });
    return sendSuccess(res, 200, `Execution ${execution.status === "cancelled" ? "cancelled" : "cancellation requested"}.`, execution, requestId);
  } catch (err) {
    console.error("CancelExecution Error:", err);
    return sendError(res, err.message?.includes("not found") ? 404 : err.message?.includes("already") ? 409 : 500, err.message || "Failed to cancel execution.", requestId);
  }
};

/** EXT-036 §5/§21 "Archived". POST /api/v1/ai/executions/:executionId/archive */
export const ArchiveExecution = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const ctx = buildContext(req);
    if (!ctx.tenantId) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasAIAccess(ctx.permissions)) return sendError(res, 403, "Permission denied.", requestId);
    const execution = await AIOrchestrationService.archiveExecution({ tenantId: ctx.tenantId, userId: ctx.userId, executionId: req.params.executionId });
    return sendSuccess(res, 200, "Execution archived successfully.", execution, requestId);
  } catch (err) {
    console.error("ArchiveExecution Error:", err);
    return sendError(res, err.message?.includes("not found") ? 404 : err.message?.includes("cannot be archived") || err.message?.includes("already archived") ? 409 : 500, err.message || "Failed to archive execution.", requestId);
  }
};

/** 6. POST /api/v1/ai/tools/approval */
export const DecideApproval = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const ctx = buildContext(req);
    if (!ctx.tenantId) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasAIAccess(ctx.permissions)) return sendError(res, 403, "Permission denied.", requestId);
    const { approvalRequestId, decision, reason } = req.body;
    if (!approvalRequestId || !decision) return sendError(res, 400, "approvalRequestId and decision are required.", requestId);

    const result = await AIOrchestrationService.decideApproval({ ...ctx, approvalRequestId, decision, reason });
    return sendSuccess(res, 200, `Approval request ${result.status}.`, result, requestId);
  } catch (err) {
    console.error("DecideApproval Error:", err);
    const statusCode = err.message?.includes("not found") ? 404 : err.message?.includes("Only a user") ? 403 : err.message?.includes("already") ? 409 : 400;
    return sendError(res, statusCode, err.message || "Failed to decide approval request.", requestId);
  }
};

/** 7. GET /api/v1/ai/executions */
export const ListExecutions = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const ctx = buildContext(req);
    if (!ctx.tenantId) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasAIAccess(ctx.permissions)) return sendError(res, 403, "Permission denied.", requestId);
    const result = await AIOrchestrationService.listExecutions({ tenantId: ctx.tenantId, userId: ctx.userId, page: req.query.page, pageSize: req.query.pageSize });
    return sendSuccess(res, 200, "AI executions retrieved successfully.", result, requestId);
  } catch (err) {
    console.error("ListExecutions Error:", err);
    return sendError(res, 500, err.message || "Failed to list AI executions.", requestId);
  }
};

/** EXT-029 §18 "Monitoring". GET /api/v1/ai/executions/metrics — admin-only, mirrors AmadeusMetricsController's own gate on operational metrics. Must be registered before the "/executions/:executionId" wildcard route. */
export const GetWorkflowMetrics = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const ctx = buildContext(req);
    if (!ctx.tenantId) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasAIAccess(ctx.permissions) || !ctx.permissions.includes("admin")) return sendError(res, 403, "Permission denied.", requestId);
    const metrics = await AIOrchestrationService.getWorkflowMetrics({ tenantId: ctx.tenantId });
    return sendSuccess(res, 200, "AI workflow metrics retrieved successfully.", metrics, requestId);
  } catch (err) {
    console.error("GetWorkflowMetrics Error:", err);
    return sendError(res, 500, err.message || "Failed to retrieve AI workflow metrics.", requestId);
  }
};

/** 8. GET /api/v1/ai/executions/:executionId */
export const GetExecutionById = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const ctx = buildContext(req);
    if (!ctx.tenantId) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasAIAccess(ctx.permissions)) return sendError(res, 403, "Permission denied.", requestId);
    const execution = await AIOrchestrationService.getExecutionById({ tenantId: ctx.tenantId, userId: ctx.userId, executionId: req.params.executionId });
    return sendSuccess(res, 200, "AI execution details retrieved successfully.", execution, requestId);
  } catch (err) {
    console.error("GetExecutionById Error:", err);
    return sendError(res, err.message?.includes("not found") ? 404 : 500, err.message || "Failed to retrieve AI execution.", requestId);
  }
};

/** GET /api/v1/ai/tools/providers/status */
export const GetOrchestrationProviderStatus = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const ctx = buildContext(req);
    if (!ctx.tenantId) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasAIAccess(ctx.permissions)) return sendError(res, 403, "Permission denied.", requestId);
    const statusData = await AIOrchestrationService.getProviderStatus();
    return sendSuccess(res, 200, "AI orchestration provider status retrieved successfully.", statusData, requestId);
  } catch (err) {
    console.error("GetOrchestrationProviderStatus Error:", err);
    return sendError(res, 500, err.message || "Failed to check provider status.", requestId);
  }
};
