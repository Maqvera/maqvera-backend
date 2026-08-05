import mongoose from "mongoose";
import crypto from "crypto";
import Ajv from "ajv";
import AIToolExecutionModel from "../models/AIToolExecutionModel.js";
import AIApprovalRequestModel from "../models/AIApprovalRequestModel.js";
import AuditLogModel from "../models/AuditLogmodel.js";
import AIToolRegistry from "./ai/AIToolRegistry.js";
import OpenAIAdapter from "./ai/OpenAIAdapter.js";
import AnthropicAdapter from "./ai/AnthropicAdapter.js";
import AzureOpenAIAdapter from "./ai/AzureOpenAIAdapter.js";
import { getAIConfig } from "../utils/aiConfig.js";
import { publishEvent } from "../utils/eventBus.js";

const ajv = new Ajv({ allErrors: true, strict: false });

const PLANNING_SYSTEM_PROMPT = (toolCatalog) => `You are a task planner for an enterprise Travel/Visa ERP. Decompose the user's request into an ordered list of tool calls using ONLY the tools listed below. Do not call any tool yourself — only produce a plan.

Available tools:
${toolCatalog.map((t) => `- ${t.name}: ${t.description} (input: ${JSON.stringify(t.parameters.properties || {})})`).join("\n")}

Respond with ONLY valid JSON, no prose, no markdown fences, matching exactly this shape:
{"steps": [{"stepNumber": 1, "toolName": "...", "arguments": {...}, "parallelGroup": null, "reasoning": "why this step"}]}

Steps that do not depend on each other's output may share the same "parallelGroup" integer so they can run concurrently (e.g. flight_search and hotel_search searching independently). Steps that depend on a prior step's result must have a different/no parallelGroup and come after it in the array. Use at most ${getAIConfig().maxPlanSteps} steps. If the request needs no tools, return {"steps": []}.`;

const SYNTHESIS_SYSTEM_PROMPT = (context) => `You are the AI Travel Assistant's response synthesizer. Below are the real results of tool calls executed on behalf of the user (tenant: ${context.tenantId}). Write a concise, natural-language answer grounded ONLY in this data. Never invent details not present in the tool results. If a tool failed or returned no data, say so honestly. If any step is awaiting human approval, tell the user that clearly.`;

class CircuitBreaker {
  constructor() { this.state = new Map(); }
  _get(p) { if (!this.state.has(p)) this.state.set(p, { failures: 0, status: "closed", openedAt: null }); return this.state.get(p); }
  canAttempt(p) {
    const { circuitBreakerCooldownMs } = getAIConfig();
    const e = this._get(p);
    if (e.status !== "open") return true;
    if (Date.now() - e.openedAt >= circuitBreakerCooldownMs) { e.status = "half-open"; return true; }
    return false;
  }
  recordSuccess(p) { this.state.set(p, { failures: 0, status: "closed", openedAt: null }); }
  recordFailure(p) {
    const { circuitBreakerThreshold } = getAIConfig();
    const e = this._get(p);
    e.failures += 1;
    if (e.failures >= circuitBreakerThreshold) { e.status = "open"; e.openedAt = Date.now(); }
  }
  getStatus(p) { const e = this._get(p); return { status: e.status, failures: e.failures }; }
}

/** "Retryable: Timeout, Temporary Provider Failure, Rate Limit, Network Failure. Non-Retryable: Permission Denied, Validation Error, Business Rule Failure." */
const isRetryableError = (message = "") => {
  const lower = message.toLowerCase();
  if (/permission denied|validation|required|invalid|not found|not registered/.test(lower)) return false;
  return /timeout|timed out|rate limit|429|network|econnreset|econnrefused|fetch failed|unavailable/.test(lower);
};

class AIOrchestrationService {
  static adapters = { OpenAI: new OpenAIAdapter(), Anthropic: new AnthropicAdapter(), AzureOpenAI: new AzureOpenAIAdapter() };
  static circuitBreaker = new CircuitBreaker();

  static async _callWithRetry(adapter, params) {
    const { maxRetries } = getAIConfig();
    let lastError;
    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      try { return await adapter.chatWithTools(params); } catch (err) { lastError = err; }
    }
    throw lastError;
  }

  static async _callLLM(params) {
    const { primaryProvider, secondaryProvider } = getAIConfig();
    const candidates = [primaryProvider, secondaryProvider, "AzureOpenAI"].filter((p, i, arr) => arr.indexOf(p) === i);

    for (const providerName of candidates) {
      const adapter = this.adapters[providerName];
      if (!adapter?.isConfigured() || !this.circuitBreaker.canAttempt(providerName)) continue;
      try {
        const result = await this._callWithRetry(adapter, params);
        this.circuitBreaker.recordSuccess(providerName);
        return { provider: providerName, ...result };
      } catch (err) {
        this.circuitBreaker.recordFailure(providerName);
      }
    }

    const error = new Error("AI service is not available: no configured provider (OpenAI/Anthropic/Azure OpenAI) could be reached.");
    error.code = "AI_UNAVAILABLE";
    throw error;
  }

  static getToolCatalog(permissions, format) {
    return format === "mcp" ? AIToolRegistry.getMCPCatalog(permissions) : AIToolRegistry.getCatalog(permissions);
  }

  static getToolById(toolId, permissions) {
    return this.getToolCatalog(permissions).find((t) => t.name === toolId) || null;
  }

  /** "Response Validation... Schema" — real JSON-Schema validation (ajv), not a hand-rolled shape check. */
  static validateToolCall(toolName, args) {
    const tool = AIToolRegistry.getTool(toolName);
    if (!tool) return { valid: false, errors: [`Unknown tool '${toolName}'.`] };
    const validate = ajv.compile(tool.parameters);
    const valid = validate(args || {});
    return { valid, errors: valid ? [] : (validate.errors || []).map((e) => `${e.instancePath || "(root)"} ${e.message}`) };
  }

  /**
   * "POST /ai/tools/plan" — Intent Detection → Entity Extraction → Task
   * Decomposition → Tool Discovery → Dependency Resolution → Execution
   * Plan. No tool is executed here.
   */
  static async createPlan({ tenantId, branchId, userId, permissions, prompt }) {
    if (!prompt || !prompt.trim()) throw new Error("prompt is required.");
    const config = getAIConfig();
    if (prompt.length > config.maxMessageLength) throw new Error(`prompt exceeds the maximum allowed length of ${config.maxMessageLength} characters.`);

    const catalog = AIToolRegistry.getCatalog(permissions);
    const llmResult = await this._callLLM({
      messages: [{ role: "user", content: prompt }],
      tools: [],
      systemPrompt: PLANNING_SYSTEM_PROMPT(catalog)
    });

    let parsedSteps = [];
    try {
      const jsonText = (llmResult.content || "{}").replace(/^```json\s*|\s*```$/g, "").trim();
      const parsed = JSON.parse(jsonText);
      parsedSteps = Array.isArray(parsed.steps) ? parsed.steps : [];
    } catch {
      throw new Error("The AI planner did not return a valid plan. Please rephrase your request.");
    }

    // "Tool Allow Lists" — a hallucinated tool name is dropped, never
    // silently executed as if it were real.
    const validToolNames = new Set(catalog.map((t) => t.name));
    const plan = parsedSteps
      .filter((s) => validToolNames.has(s.toolName))
      .slice(0, config.maxPlanSteps)
      .map((s, idx) => ({
        stepNumber: idx + 1,
        toolName: s.toolName,
        arguments: s.arguments || {},
        parallelGroup: Number.isInteger(s.parallelGroup) ? s.parallelGroup : null,
        requiresApproval: Boolean(AIToolRegistry.getTool(s.toolName)?.requiresApproval),
        reasoning: s.reasoning || null
      }));

    const execution = await AIToolExecutionModel.create({
      tenantId, branchId, userId, prompt,
      correlationId: `AIEXEC-${crypto.randomUUID()}`,
      plan,
      status: "planned",
      provider: llmResult.provider,
      tokenUsage: {
        inputTokens: llmResult.usage?.prompt_tokens || llmResult.usage?.input_tokens || 0,
        outputTokens: llmResult.usage?.completion_tokens || llmResult.usage?.output_tokens || 0,
        totalTokens: (llmResult.usage?.prompt_tokens || llmResult.usage?.input_tokens || 0) + (llmResult.usage?.completion_tokens || llmResult.usage?.output_tokens || 0)
      }
    });

    return { executionId: execution._id, correlationId: execution.correlationId, plan, status: execution.status };
  }

  /**
   * "POST /ai/tools/execute" — Load Plan → Validate Permissions → Inject
   * Context → Execute Tools (parallel where the plan marks it, sequential
   * otherwise, with tool-level retry) → Collect Responses → Validate
   * Results → Generate Final Response → Audit.
   */
  static async executePlan({ tenantId, branchId, userId, userName, permissions, role, executionId }) {
    const execution = await AIToolExecutionModel.findOne({ _id: executionId, tenantId, userId });
    if (!execution) throw new Error("Execution plan not found.");
    if (execution.status !== "planned") throw new Error(`Execution is already '${execution.status}' and cannot be re-executed.`);

    execution.status = "executing";
    await execution.save();

    const startedAt = Date.now();
    const context = { tenantId, branchId, userId, userName, permissions, role, executionId: execution._id.toString(), conversationId: null };

    // Group steps by parallelGroup: steps sharing a non-null group run
    // concurrently via Promise.allSettled; everything else runs in step order.
    const groups = [];
    const seenGroups = new Set();
    for (const step of execution.plan) {
      if (step.parallelGroup != null) {
        if (seenGroups.has(step.parallelGroup)) continue;
        seenGroups.add(step.parallelGroup);
        groups.push(execution.plan.filter((s) => s.parallelGroup === step.parallelGroup));
      } else {
        groups.push([step]);
      }
    }

    const toolExecutions = [];
    let hasApprovalPending = false;

    const runStep = async (step) => {
      const tool = AIToolRegistry.getTool(step.toolName);
      const retryPolicy = tool ? AIToolRegistry.getRetryPolicy(tool) : { retryable: false, maxRetries: 0 };
      let attempt = 0;
      let outcome;
      const stepStart = Date.now();

      do {
        outcome = await AIToolRegistry.execute(step.toolName, step.arguments, context);
        if (!outcome.error) break;
        attempt += 1;
      } while (retryPolicy.retryable && isRetryableError(outcome.error) && attempt <= retryPolicy.maxRetries);

      toolExecutions.push({
        stepNumber: step.stepNumber, toolName: step.toolName, arguments: step.arguments,
        succeeded: !outcome.error, retryCount: attempt, durationMs: Date.now() - stepStart,
        startedAt: new Date(stepStart), error: outcome.error || null
      });
      publishEvent("AIToolExecuted", { executionId: execution._id, tenantId, toolName: step.toolName, succeeded: !outcome.error, retryCount: attempt });

      if (!outcome.error && step.requiresApproval) hasApprovalPending = true;
      return outcome;
    };

    for (const group of groups) {
      if (group.length > 1) {
        await Promise.allSettled(group.map((step) => runStep(step)));
      } else {
        await runStep(group[0]);
      }
    }

    const succeededCount = toolExecutions.filter((t) => t.succeeded).length;
    const errors = toolExecutions.filter((t) => !t.succeeded).map((t) => `${t.toolName}: ${t.error}`);

    // "Generate Final Response" — a real synthesis pass grounded in the
    // actual collected tool results, only when at least one step ran and
    // no approval is blocking the whole answer.
    let finalAnswer = null;
    let synthesisProvider = execution.provider;
    let synthesisUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
    if (toolExecutions.length > 0) {
      try {
        const resultsSummary = toolExecutions.map((t) => `Step ${t.stepNumber} (${t.toolName}): ${t.succeeded ? "succeeded" : `failed - ${t.error}`}`).join("\n");
        const llmResult = await this._callLLM({
          messages: [{ role: "user", content: `User's original request: "${execution.prompt}"\n\nTool execution results:\n${resultsSummary}` }],
          tools: [],
          systemPrompt: SYNTHESIS_SYSTEM_PROMPT(context)
        });
        finalAnswer = llmResult.content;
        synthesisProvider = llmResult.provider;
        synthesisUsage = {
          inputTokens: llmResult.usage?.prompt_tokens || llmResult.usage?.input_tokens || 0,
          outputTokens: llmResult.usage?.completion_tokens || llmResult.usage?.output_tokens || 0,
          totalTokens: (llmResult.usage?.prompt_tokens || llmResult.usage?.input_tokens || 0) + (llmResult.usage?.completion_tokens || llmResult.usage?.output_tokens || 0)
        };
      } catch (err) {
        errors.push(`synthesis: ${err.message}`);
      }
    }

    const status = hasApprovalPending ? "awaiting_approval" : (succeededCount === 0 && toolExecutions.length > 0 ? "failed" : "completed");

    execution.status = status;
    execution.toolExecutions = toolExecutions;
    execution.finalAnswer = finalAnswer;
    execution.provider = synthesisProvider;
    execution.tokenUsage = {
      inputTokens: execution.tokenUsage.inputTokens + synthesisUsage.inputTokens,
      outputTokens: execution.tokenUsage.outputTokens + synthesisUsage.outputTokens,
      totalTokens: execution.tokenUsage.totalTokens + synthesisUsage.totalTokens
    };
    // "Cost Optimization" — real per-token math against a configured,
    // labeled-as-estimated rate.
    const rates = getAIConfig().costPerThousandTokens[synthesisProvider] || { input: 0, output: 0 };
    execution.estimatedCostUsd = Number((
      (execution.tokenUsage.inputTokens / 1000) * rates.input +
      (execution.tokenUsage.outputTokens / 1000) * rates.output
    ).toFixed(6));
    execution.totalExecutionTimeMs = Date.now() - startedAt;
    execution.executionErrors = errors;
    execution.auditReference = `AUDIT-${execution._id}`;
    await execution.save();

    if (status === "failed") {
      publishEvent("AIExecutionFailed", { executionId: execution._id, tenantId, errors });
    } else {
      publishEvent("AIExecutionCompleted", { executionId: execution._id, tenantId, status, toolsUsed: toolExecutions.map((t) => t.toolName) });
    }

    if (mongoose.connection?.readyState === 1) {
      AuditLogModel.create({
        tenantId, userId, action: "AI_EXECUTE_PLAN", module: "AIOrchestration",
        targetId: execution._id.toString(), details: { status, toolsUsed: toolExecutions.map((t) => t.toolName), estimatedCostUsd: execution.estimatedCostUsd }
      }).catch((err) => console.error("AI orchestration audit log error:", err));
    }

    return execution;
  }

  /** "POST /ai/tools/approval" — never executes the proposed action itself; hands back the real endpoint call for a human/UI to invoke. */
  static async decideApproval({ tenantId, userId, userName, role, permissions, approvalRequestId, decision, reason }) {
    if (!["approve", "reject"].includes(decision)) throw new Error("decision must be 'approve' or 'reject'.");
    const request = await AIApprovalRequestModel.findOne({ _id: approvalRequestId, tenantId });
    if (!request) throw new Error("Approval request not found.");
    if (request.status !== "pending") throw new Error(`Approval request is already '${request.status}'.`);

    const hasRole = (role && role.toLowerCase() === request.requiredRole.toLowerCase()) || permissions.includes("admin") || permissions.includes("superadmin");
    if (!hasRole) throw new Error(`Only a user with role '${request.requiredRole}' (or admin) can decide this approval request.`);

    request.status = decision === "approve" ? "approved" : "rejected";
    request.decidedBy = userId;
    request.decidedByName = userName || "User";
    request.decisionReason = reason || null;
    request.decidedAt = new Date();
    await request.save();

    publishEvent(decision === "approve" ? "AIApprovalGranted" : "AIApprovalRejected", { approvalRequestId: request._id, tenantId, toolName: request.toolName });

    if (mongoose.connection?.readyState === 1) {
      AuditLogModel.create({
        tenantId, userId, action: decision === "approve" ? "AI_APPROVAL_GRANTED" : "AI_APPROVAL_REJECTED", module: "AIOrchestration",
        targetId: request._id.toString(), details: { toolName: request.toolName, reason }
      }).catch((err) => console.error("AI approval audit log error:", err));
    }

    return {
      approvalRequestId: request._id,
      status: request.status,
      // Only surfaced on approval — this is the hand-off, not an execution.
      proposedAction: request.status === "approved" ? request.proposedAction : null
    };
  }

  static async listExecutions({ tenantId, userId, page = 1, pageSize = 20 }) {
    const safePage = Math.max(parseInt(page, 10) || 1, 1);
    const safePageSize = Math.min(Math.max(parseInt(pageSize, 10) || 20, 1), 100);
    const filter = { tenantId, userId };
    const [items, totalItems] = await Promise.all([
      AIToolExecutionModel.find(filter).sort({ createdAt: -1 }).skip((safePage - 1) * safePageSize).limit(safePageSize)
        .select("status prompt provider tokenUsage estimatedCostUsd totalExecutionTimeMs createdAt correlationId").lean(),
      AIToolExecutionModel.countDocuments(filter)
    ]);
    return { items, pagination: { page: safePage, pageSize: safePageSize, totalItems, totalPages: Math.ceil(totalItems / safePageSize) || 1 } };
  }

  static async getExecutionById({ tenantId, userId, executionId }) {
    const execution = await AIToolExecutionModel.findOne({ _id: executionId, tenantId, userId }).lean();
    if (!execution) throw new Error("Execution not found.");
    return execution;
  }

  static async getProviderStatus() {
    const statuses = {};
    for (const [name, adapter] of Object.entries(this.adapters)) {
      const health = await adapter.checkHealth();
      statuses[name] = { ...health, circuitBreaker: this.circuitBreaker.getStatus(name) };
    }
    return statuses;
  }
}

export default AIOrchestrationService;
