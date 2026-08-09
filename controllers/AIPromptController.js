import AIPromptService from "../services/AIPromptService.js";
import { getAIPromptConfig } from "../utils/aiPromptConfig.js";
import { sendError, sendSuccess } from "../utils/apiResponse.js";
import { createRequestId } from "../utils/authTokens.js";

const AI_PERMISSION = "ai.assistant.use";

const buildContext = (req) => ({
  tenantId: req.auth?.tenantId || null,
  userId: req.auth?.userId || req.auth?.id,
  permissions: req.auth?.permissions || [],
  role: req.auth?.role || req.auth?.roles?.[0] || ""
});

const hasAIAccess = (permissions) => permissions.includes(AI_PERMISSION) || permissions.includes("admin");
const hasPromptManageAccess = (permissions) => {
  const { managePermission } = getAIPromptConfig();
  return permissions.includes(managePermission) || permissions.includes("admin");
};

/** 1. POST /api/v1/ai/prompts */
export const CreatePrompt = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const ctx = buildContext(req);
    if (!ctx.tenantId) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPromptManageAccess(ctx.permissions)) return sendError(res, 403, "Permission denied.", requestId);
    const { promptType, key, language, name, description, content } = req.body;
    const result = await AIPromptService.createPrompt({ tenantId: ctx.tenantId, userId: ctx.userId, promptType, key, language, name, description, content });
    return sendSuccess(res, 201, "Prompt created successfully.", result, requestId);
  } catch (err) {
    console.error("CreatePrompt Error:", err);
    return sendError(res, err.message?.includes("required") || err.message?.includes("Invalid") || err.message?.includes("Unsupported") || err.message?.includes("already exists") ? 400 : 500, err.message || "Failed to create prompt.", requestId);
  }
};

/** 2. POST /api/v1/ai/prompts/:promptId/versions */
export const CreatePromptVersion = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const ctx = buildContext(req);
    if (!ctx.tenantId) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPromptManageAccess(ctx.permissions)) return sendError(res, 403, "Permission denied.", requestId);
    const { content, description } = req.body;
    const version = await AIPromptService.createVersion({ tenantId: ctx.tenantId, userId: ctx.userId, promptId: req.params.promptId, content, description });
    return sendSuccess(res, 201, "Prompt version created successfully.", version, requestId);
  } catch (err) {
    console.error("CreatePromptVersion Error:", err);
    return sendError(res, err.message?.includes("not found") ? 404 : err.message?.includes("required") ? 400 : 500, err.message || "Failed to create prompt version.", requestId);
  }
};

/** 3. PATCH /api/v1/ai/prompts/:promptId/versions/:version/status — Draft -> Review -> Testing -> Approved -> Published -> Archived. */
export const TransitionPromptVersionStatus = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const ctx = buildContext(req);
    if (!ctx.tenantId) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPromptManageAccess(ctx.permissions)) return sendError(res, 403, "Permission denied.", requestId);
    const { status, reason } = req.body;
    if (!status) return sendError(res, 400, "status is required.", requestId);
    const version = await AIPromptService.transitionVersionStatus({
      tenantId: ctx.tenantId, userId: ctx.userId, permissions: ctx.permissions,
      promptId: req.params.promptId, version: Number(req.params.version), newStatus: status, reason
    });
    return sendSuccess(res, 200, `Prompt version transitioned to '${status}'.`, version, requestId);
  } catch (err) {
    console.error("TransitionPromptVersionStatus Error:", err);
    return sendError(res, err.message?.includes("not found") ? 404 : err.message?.includes("Only a user") ? 403 : err.message?.includes("Cannot transition") || err.message?.includes("Invalid status") ? 409 : 500, err.message || "Failed to transition prompt version status.", requestId);
  }
};

/** 4. POST /api/v1/ai/prompts/:promptId/rollback */
export const RollbackPrompt = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const ctx = buildContext(req);
    if (!ctx.tenantId) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPromptManageAccess(ctx.permissions)) return sendError(res, 403, "Permission denied.", requestId);
    const { targetVersion } = req.body;
    if (!targetVersion) return sendError(res, 400, "targetVersion is required.", requestId);
    const version = await AIPromptService.rollback({ tenantId: ctx.tenantId, userId: ctx.userId, permissions: ctx.permissions, promptId: req.params.promptId, targetVersion: Number(targetVersion) });
    return sendSuccess(res, 200, `Prompt rolled back to version ${targetVersion}.`, version, requestId);
  } catch (err) {
    console.error("RollbackPrompt Error:", err);
    return sendError(res, err.message?.includes("not found") ? 404 : err.message?.includes("Only a user") ? 403 : err.message?.includes("already the published") ? 409 : 500, err.message || "Failed to roll back prompt.", requestId);
  }
};

/** 5. GET /api/v1/ai/prompts */
export const ListPrompts = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const ctx = buildContext(req);
    if (!ctx.tenantId) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasAIAccess(ctx.permissions)) return sendError(res, 403, "Permission denied.", requestId);
    const result = await AIPromptService.listPrompts({ tenantId: ctx.tenantId, promptType: req.query.promptType, page: req.query.page, pageSize: req.query.pageSize });
    return sendSuccess(res, 200, "Prompts retrieved successfully.", result, requestId);
  } catch (err) {
    console.error("ListPrompts Error:", err);
    return sendError(res, 500, err.message || "Failed to list prompts.", requestId);
  }
};

/** 6. GET /api/v1/ai/prompts/:promptId — includes every version (§19 immutable history) and real usage/quality metrics. */
export const GetPromptById = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const ctx = buildContext(req);
    if (!ctx.tenantId) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasAIAccess(ctx.permissions)) return sendError(res, 403, "Permission denied.", requestId);
    const [result, metrics] = await Promise.all([
      AIPromptService.getPromptWithVersions({ tenantId: ctx.tenantId, promptId: req.params.promptId }),
      AIPromptService.getPromptMetrics({ tenantId: ctx.tenantId, promptId: req.params.promptId })
    ]);
    return sendSuccess(res, 200, "Prompt retrieved successfully.", { ...result, metrics }, requestId);
  } catch (err) {
    console.error("GetPromptById Error:", err);
    return sendError(res, err.message?.includes("not found") ? 404 : 500, err.message || "Failed to retrieve prompt.", requestId);
  }
};

/** 7. POST /api/v1/ai/prompts/:promptId/test-cases */
export const CreateTestCase = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const ctx = buildContext(req);
    if (!ctx.tenantId) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPromptManageAccess(ctx.permissions)) return sendError(res, 403, "Permission denied.", requestId);
    const { name, variables, userMessage, expectedContains, expectedNotContains } = req.body;
    const testCase = await AIPromptService.createTestCase({ tenantId: ctx.tenantId, userId: ctx.userId, promptId: req.params.promptId, name, variables, userMessage, expectedContains, expectedNotContains });
    return sendSuccess(res, 201, "Test case created successfully.", testCase, requestId);
  } catch (err) {
    console.error("CreateTestCase Error:", err);
    return sendError(res, err.message?.includes("not found") ? 404 : err.message?.includes("required") ? 400 : 500, err.message || "Failed to create test case.", requestId);
  }
};

/** 8. GET /api/v1/ai/prompts/:promptId/test-cases */
export const ListTestCases = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const ctx = buildContext(req);
    if (!ctx.tenantId) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasAIAccess(ctx.permissions)) return sendError(res, 403, "Permission denied.", requestId);
    const testCases = await AIPromptService.listTestCases({ tenantId: ctx.tenantId, promptId: req.params.promptId });
    return sendSuccess(res, 200, "Test cases retrieved successfully.", testCases, requestId);
  } catch (err) {
    console.error("ListTestCases Error:", err);
    return sendError(res, 500, err.message || "Failed to list test cases.", requestId);
  }
};

/** 9. DELETE /api/v1/ai/prompts/test-cases/:testCaseId */
export const DeleteTestCase = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const ctx = buildContext(req);
    if (!ctx.tenantId) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPromptManageAccess(ctx.permissions)) return sendError(res, 403, "Permission denied.", requestId);
    const testCase = await AIPromptService.deleteTestCase({ tenantId: ctx.tenantId, testCaseId: req.params.testCaseId });
    return sendSuccess(res, 200, "Test case deleted successfully.", testCase, requestId);
  } catch (err) {
    console.error("DeleteTestCase Error:", err);
    return sendError(res, err.message?.includes("not found") ? 404 : 500, err.message || "Failed to delete test case.", requestId);
  }
};

/** 10. POST /api/v1/ai/prompts/:promptId/versions/:version/run-tests */
export const RunPromptTestSuite = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const ctx = buildContext(req);
    if (!ctx.tenantId) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPromptManageAccess(ctx.permissions)) return sendError(res, 403, "Permission denied.", requestId);
    const result = await AIPromptService.runTestSuite({ tenantId: ctx.tenantId, userId: ctx.userId, promptId: req.params.promptId, version: Number(req.params.version) });
    return sendSuccess(res, 200, "Prompt test suite run completed.", result, requestId);
  } catch (err) {
    console.error("RunPromptTestSuite Error:", err);
    const statusCode = err.message?.includes("not found") ? 404 : err.code === "AI_UNAVAILABLE" ? 503 : err.message?.includes("no active test cases") ? 400 : 500;
    return sendError(res, statusCode, err.message || "Failed to run prompt test suite.", requestId);
  }
};
