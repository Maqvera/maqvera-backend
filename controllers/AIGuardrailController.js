import AIGuardrailService from "../services/ai/AIGuardrailService.js";
import { getAIGuardrailConfig } from "../utils/aiGuardrailConfig.js";
import { sendError, sendSuccess } from "../utils/apiResponse.js";
import { createRequestId } from "../utils/authTokens.js";

const AI_PERMISSION = "ai.assistant.use";

const buildContext = (req) => ({
  tenantId: req.auth?.tenantId || null,
  branchId: req.auth?.branchId || "main",
  userId: req.auth?.userId || req.auth?.id,
  permissions: req.auth?.permissions || [],
  role: req.auth?.role || req.auth?.roles?.[0] || ""
});

const hasAIAccess = (permissions) => permissions.includes(AI_PERMISSION) || permissions.includes("admin");
const hasGuardrailManageAccess = (permissions) => {
  const { managePermission } = getAIGuardrailConfig();
  return permissions.includes(managePermission) || permissions.includes("admin");
};
// §19 "Monitoring" surfaces blocked/flagged/high-risk activity across the
// whole tenant — admin-only, same gating as GetWorkflowMetrics.
const hasAdminAccess = (permissions) => permissions.includes("admin");

/** 1. POST /api/v1/ai/guardrails/policies */
export const CreatePolicy = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const ctx = buildContext(req);
    if (!ctx.tenantId) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasGuardrailManageAccess(ctx.permissions)) return sendError(res, 403, "Permission denied.", requestId);
    const { category, name, description, ruleType, toolName, allowedRoles, riskLevelThreshold } = req.body;
    const policy = await AIGuardrailService.createPolicy({ tenantId: ctx.tenantId, branchId: ctx.branchId, userId: ctx.userId, category, name, description, ruleType, toolName, allowedRoles, riskLevelThreshold });
    return sendSuccess(res, 201, "AI guardrail policy created successfully.", policy, requestId);
  } catch (err) {
    console.error("CreatePolicy Error:", err);
    return sendError(res, err.message?.includes("required") || err.message?.includes("must be one of") ? 400 : 500, err.message || "Failed to create policy.", requestId);
  }
};

/** 2. GET /api/v1/ai/guardrails/policies */
export const ListPolicies = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const ctx = buildContext(req);
    if (!ctx.tenantId) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasAIAccess(ctx.permissions)) return sendError(res, 403, "Permission denied.", requestId);
    const result = await AIGuardrailService.listPolicies({ tenantId: ctx.tenantId, category: req.query.category, isActive: req.query.isActive, page: req.query.page, pageSize: req.query.pageSize });
    return sendSuccess(res, 200, "AI guardrail policies retrieved successfully.", result, requestId);
  } catch (err) {
    console.error("ListPolicies Error:", err);
    return sendError(res, 500, err.message || "Failed to list policies.", requestId);
  }
};

/** 3. PATCH /api/v1/ai/guardrails/policies/:policyId */
export const UpdatePolicy = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const ctx = buildContext(req);
    if (!ctx.tenantId) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasGuardrailManageAccess(ctx.permissions)) return sendError(res, 403, "Permission denied.", requestId);
    const policy = await AIGuardrailService.updatePolicy({ tenantId: ctx.tenantId, userId: ctx.userId, policyId: req.params.policyId, updates: req.body || {} });
    return sendSuccess(res, 200, "AI guardrail policy updated successfully.", policy, requestId);
  } catch (err) {
    console.error("UpdatePolicy Error:", err);
    return sendError(res, err.message?.includes("not found") ? 404 : 500, err.message || "Failed to update policy.", requestId);
  }
};

/** 4. DELETE /api/v1/ai/guardrails/policies/:policyId */
export const DeletePolicy = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const ctx = buildContext(req);
    if (!ctx.tenantId) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasGuardrailManageAccess(ctx.permissions)) return sendError(res, 403, "Permission denied.", requestId);
    const policy = await AIGuardrailService.deletePolicy({ tenantId: ctx.tenantId, policyId: req.params.policyId });
    return sendSuccess(res, 200, "AI guardrail policy deleted successfully.", policy, requestId);
  } catch (err) {
    console.error("DeletePolicy Error:", err);
    return sendError(res, err.message?.includes("not found") ? 404 : 500, err.message || "Failed to delete policy.", requestId);
  }
};

/** 5. GET /api/v1/ai/guardrails/audit — admin-only; every row can reveal what a user attempted/was blocked from. */
export const ListGuardrailAudit = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const ctx = buildContext(req);
    if (!ctx.tenantId) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasAdminAccess(ctx.permissions)) return sendError(res, 403, "Permission denied.", requestId);
    const result = await AIGuardrailService.listAuditEntries({ tenantId: ctx.tenantId, decision: req.query.decision, toolName: req.query.toolName, page: req.query.page, pageSize: req.query.pageSize });
    return sendSuccess(res, 200, "AI guardrail audit entries retrieved successfully.", result, requestId);
  } catch (err) {
    console.error("ListGuardrailAudit Error:", err);
    return sendError(res, 500, err.message || "Failed to list guardrail audit entries.", requestId);
  }
};

/** 6. GET /api/v1/ai/guardrails/metrics — admin-only, mirrors GetWorkflowMetrics's own gate. */
export const GetGuardrailMetrics = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const ctx = buildContext(req);
    if (!ctx.tenantId) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasAdminAccess(ctx.permissions)) return sendError(res, 403, "Permission denied.", requestId);
    const metrics = await AIGuardrailService.getGuardrailMetrics({ tenantId: ctx.tenantId });
    return sendSuccess(res, 200, "AI guardrail metrics retrieved successfully.", metrics, requestId);
  } catch (err) {
    console.error("GetGuardrailMetrics Error:", err);
    return sendError(res, 500, err.message || "Failed to retrieve guardrail metrics.", requestId);
  }
};
