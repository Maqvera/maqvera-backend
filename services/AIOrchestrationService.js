import mongoose from "mongoose";
import crypto from "crypto";
import Ajv from "ajv";
import AIToolExecutionModel from "../models/AIToolExecutionModel.js";
import AIApprovalRequestModel from "../models/AIApprovalRequestModel.js";
import AIConversationModel from "../models/AIConversationModel.js";
import AuditLogModel from "../models/AuditLogmodel.js";
import EnterpriseIncidentEngineService from "./EnterpriseIncidentEngineService.js";
import AIToolRegistry from "./ai/AIToolRegistry.js";
import AIContextMemory from "./ai/AIContextMemory.js";
import AIPromptService from "./AIPromptService.js";
import AIGuardrailService from "./ai/AIGuardrailService.js";
import AIObservabilityService from "./ai/AIObservabilityService.js";
import AIModelRouterService from "./ai/AIModelRouterService.js";
import { getAIConfig, getAIWorkflowRecoveryConfig } from "../utils/aiConfig.js";
import { getAIModelConfig } from "../utils/aiModelConfig.js";
import { publishEvent } from "../utils/eventBus.js";
import logger from "../utils/logger.js";

const ajv = new Ajv({ allErrors: true, strict: false });

// EXT-031 "AI Prompt Management" — the planning/synthesis system prompts
// are no longer hardcoded template-literal constants here; they're
// resolved via AIPromptService.composeWorkflowPrompt (promptType
// "workflow", keys "planning"/"synthesis"), falling back to the exact
// same text relocated verbatim into utils/aiPromptDefaults.js when a
// tenant hasn't published a custom one. The tool catalog listing itself
// is deliberately NOT part of the editable template — it's built fresh
// from the real, live AIToolRegistry every call (see _buildToolCatalogText)
// and passed in as the {{toolCatalog}} variable, so an admin can never
// publish a stale/wrong tool list that diverges from what actually exists.
const _buildToolCatalogText = (toolCatalog) => toolCatalog.map((t) => `- ${t.name}: ${t.description} (input: ${JSON.stringify(t.parameters.properties || {})})`).join("\n");

/** "Retryable: Timeout, Temporary Provider Failure, Rate Limit, Network Failure. Non-Retryable: Permission Denied, Validation Error, Business Rule Failure." */
const isRetryableError = (message = "") => {
  const lower = message.toLowerCase();
  if (/permission denied|validation|required|invalid|not found|not registered/.test(lower)) return false;
  return /timeout|timed out|rate limit|429|network|econnreset|econnrefused|fetch failed|unavailable/.test(lower);
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** EXT-029 §11 "Retry Strategy -> Exponential Backoff." attempt 0 = the delay before the 1st retry (the original attempt itself is never delayed). Jittered ±20% so many concurrently-retrying steps don't all hammer a struggling provider in lockstep. */
const backoffDelayMs = (attempt) => {
  const { retryBaseDelayMs, retryBackoffMultiplier, retryMaxDelayMs } = getAIConfig();
  const raw = Math.min(retryBaseDelayMs * (retryBackoffMultiplier ** attempt), retryMaxDelayMs);
  const jitter = raw * 0.2 * (Math.random() * 2 - 1);
  return Math.max(0, Math.round(raw + jitter));
};

/** EXT-029 §6/§8 "Timed Out" / "Timer". Wraps a tool call so a hung provider request fails fast with a real, isRetryableError-classified timeout instead of blocking the step (and the whole group it's in) indefinitely. */
const withTimeout = (promise, ms, label) => {
  let timer;
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms.`)), ms);
  });
  return Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(timer));
};

class AIOrchestrationService {
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
   * EXT-028 §16 "Memory Integration — Planner reads Session Memory."
   * Shared by createPlan() and executePlan() so the formal plan-based
   * engine reuses the exact same EXT-027 session memory the conversational
   * `AIAssistantService.chat()` path already reads/writes — a user who
   * searched flights via chat, then triggers a formal plan against the
   * same conversationId, doesn't have to restate the route/dates. Same
   * lazy-expiry check as chat(): a session whose memory already went idle
   * starts clean rather than reusing stale data.
   */
  static _deriveSessionMemory(conversation) {
    if (!conversation) return AIContextMemory.empty();
    const storedContext = conversation.context?.toObject ? conversation.context.toObject() : conversation.context;
    const expired = storedContext?.expiresAt && new Date(storedContext.expiresAt).getTime() < Date.now();
    return (storedContext && storedContext.flight && !expired) ? storedContext : AIContextMemory.empty();
  }

  /**
   * "POST /ai/tools/plan" — Intent Detection → Entity Extraction → Task
   * Decomposition → Tool Discovery → Dependency Resolution → Execution
   * Plan. No tool is executed here.
   */
  static async createPlan({ tenantId, branchId, userId, userName, role, permissions, prompt, conversationId = null }) {
    if (!prompt || !prompt.trim()) throw new Error("prompt is required.");
    const config = getAIConfig();
    if (prompt.length > config.maxMessageLength) throw new Error(`prompt exceeds the maximum allowed length of ${config.maxMessageLength} characters.`);

    // EXT-032 §9 "Prompt injection detected before execution" — checked on
    // the raw planning prompt itself, persisted on the execution, and
    // re-applied as defense-in-depth at executePlan() time (see below),
    // exactly mirroring AIAssistantService.chat()'s own per-turn check.
    const promptInjectionFlagged = AIGuardrailService.detectPromptInjection(prompt);

    // EXT-028 §16 "Memory Integration" — optional; a plan created outside
    // any conversation (conversationId omitted) behaves exactly as before.
    let conversation = null;
    if (conversationId) {
      conversation = await AIConversationModel.findOne({ _id: conversationId, tenantId, userId });
    }
    const memorySummary = conversation ? AIContextMemory.describeForPrompt(this._deriveSessionMemory(conversation)) : null;

    const catalog = AIToolRegistry.getCatalog(permissions);
    const { text: planningSystemPrompt, versionRef: planningVersionRef } = await AIPromptService.composeWorkflowPrompt({
      tenantId, branchId, key: "planning", language: "en",
      variables: { toolCatalog: _buildToolCatalogText(catalog), maxPlanSteps: config.maxPlanSteps, tenantName: tenantId, branchName: branchId }
    });
    const planningPromptFull = planningSystemPrompt + (memorySummary ? `\n\nKNOWN CONTEXT FROM THIS SESSION (reuse these details instead of asking the user again or re-planning a search that's already been done):\n${memorySummary}` : "");

    const planningCallStartedAt = Date.now();
    const llmResult = await AIModelRouterService.route({
      tenantId, branchId, category: "planning", correlationId: conversation?._id?.toString() || null,
      messages: [{ role: "user", content: prompt }], tools: [], systemPrompt: planningPromptFull
    });
    if (planningVersionRef) {
      AIPromptService.recordUsage({
        versionId: planningVersionRef.versionId, latencyMs: Date.now() - planningCallStartedAt,
        tokens: (llmResult.usage?.prompt_tokens || llmResult.usage?.input_tokens || 0) + (llmResult.usage?.completion_tokens || llmResult.usage?.output_tokens || 0),
        succeeded: true
      }).catch(() => {});
    }

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
    // Pre-generated so each step's idempotencyKey (EXT-036 §23) can be
    // embedded into the plan itself, before the document is inserted.
    const executionObjectId = new mongoose.Types.ObjectId();
    const validToolNames = new Set(catalog.map((t) => t.name));
    const keptSteps = parsedSteps.filter((s) => validToolNames.has(s.toolName)).slice(0, config.maxPlanSteps);

    // EXT-028 §8 "Dependency Rules" — the LLM's own stepNumbers (assigned
    // before filtering) don't survive filtering/truncation intact, so
    // dependsOn references must be remapped through the same
    // original->kept renumbering, exactly like stepNumber itself already
    // is below. A dependency on a step that got dropped (hallucinated tool
    // name, or truncated by maxPlanSteps) is silently omitted rather than
    // left dangling; a dependency on a later/equal step (a cycle or
    // self-reference the LLM shouldn't have produced) is dropped too,
    // never persisted as something the engine could stall on.
    const originalToNewStepNumber = new Map();
    keptSteps.forEach((s, idx) => {
      if (Number.isInteger(s.stepNumber)) originalToNewStepNumber.set(s.stepNumber, idx + 1);
    });

    const plan = keptSteps.map((s, idx) => {
      const stepNumber = idx + 1;
      const dependsOn = Array.isArray(s.dependsOn)
        ? [...new Set(s.dependsOn.map((d) => originalToNewStepNumber.get(d)).filter((mapped) => Number.isInteger(mapped) && mapped < stepNumber))]
        : [];

      // EXT-036 §10 "Conditional Branching." Remapped through the same
      // original->kept renumbering as dependsOn; dropped entirely (never
      // left dangling) if it pointed at a step that got filtered out or
      // isn't strictly earlier. Auto-folded into this step's own dependsOn
      // — the engine can't evaluate a condition on a step that hasn't
      // necessarily run yet, so the referenced step is structurally
      // guaranteed to complete (or be skipped) first.
      let runIf = null;
      if (s.runIf && typeof s.runIf === "object" && s.runIf.field) {
        const mappedStepNumber = originalToNewStepNumber.get(s.runIf.stepNumber);
        if (Number.isInteger(mappedStepNumber) && mappedStepNumber < stepNumber) {
          runIf = { stepNumber: mappedStepNumber, field: String(s.runIf.field), equals: s.runIf.equals };
          if (!dependsOn.includes(mappedStepNumber)) dependsOn.push(mappedStepNumber);
        }
      }

      return {
        stepNumber,
        toolName: s.toolName,
        arguments: s.arguments || {},
        parallelGroup: Number.isInteger(s.parallelGroup) ? s.parallelGroup : null,
        requiresApproval: Boolean(AIToolRegistry.getTool(s.toolName)?.requiresApproval),
        reasoning: s.reasoning || null,
        idempotencyKey: `${executionObjectId}:${stepNumber}`,
        dependsOn, runIf
      };
    });

    const execution = await AIToolExecutionModel.create({
      _id: executionObjectId,
      tenantId, branchId, userId,
      userName: userName || "User", role: role || "", permissions: permissions || [],
      conversationId: conversation ? conversation._id : null,
      prompt,
      correlationId: `AIEXEC-${crypto.randomUUID()}`,
      plan,
      status: "planned",
      promptInjectionFlagged,
      provider: llmResult.provider,
      model: llmResult.model,
      tokenUsage: {
        inputTokens: llmResult.usage?.prompt_tokens || llmResult.usage?.input_tokens || 0,
        outputTokens: llmResult.usage?.completion_tokens || llmResult.usage?.output_tokens || 0,
        totalTokens: (llmResult.usage?.prompt_tokens || llmResult.usage?.input_tokens || 0) + (llmResult.usage?.completion_tokens || llmResult.usage?.output_tokens || 0)
      }
    });

    return { executionId: execution._id, correlationId: execution.correlationId, plan, status: execution.status, promptInjectionFlagged };
  }

  /**
   * EXT-036 §14 "Compensation — Flight Reserved → Hotel Failed → Cancel
   * Flight Reservation → Release Resources → Rollback Workflow." Not
   * implemented as written: neither `propose_flight_booking` nor
   * `propose_hotel_booking` ever creates a real reservation at this layer —
   * each only ever creates a pending AIApprovalRequestModel row (see
   * AIToolRegistry.js's module docblock: "AI never books flights..."), so
   * there is no real flight reservation here to cancel or roll back in the
   * first place. What CAN genuinely happen is exactly what this method
   * handles: a plan proposes both a flight and a hotel, the flight proposal
   * succeeds (a pending approval now exists) while the hotel proposal
   * fails — an explicit product decision was made that this must never
   * auto-cancel the flight's pending approval, only flag it so the human
   * approver sees the partial failure before deciding.
   */
  static async _flagFlightForManualReview({ tenantId, branchId, userId, execution, flightProposalStep, hotelFailureStep }) {
    const reason = `Hotel step (${hotelFailureStep.toolName}, step ${hotelFailureStep.stepNumber}) failed in the same plan as this flight proposal (step ${flightProposalStep.stepNumber}): ${hotelFailureStep.error || "unknown error"}. Per policy, the flight proposal is NOT auto-cancelled — review manually before approving.`;

    let approvalRequest = null;
    let incident = null;

    if (mongoose.connection?.readyState === 1) {
      if (flightProposalStep.idempotencyKey) {
        approvalRequest = await AIApprovalRequestModel.findOne({ tenantId, idempotencyKey: flightProposalStep.idempotencyKey });
        if (approvalRequest) {
          approvalRequest.compensationFlag = { flagged: true, reason, relatedIncidentId: null, flaggedAt: new Date() };
        }
      }

      // "Flight" is a real, always-seeded default incident category (see
      // utils/incidentConfig.js's defaultCategories) — deliberately not the
      // EnterpriseIncidentEngineService's own stale "Operational Exception"
      // default, which isn't actually in that list and would be rejected by
      // a tenant's real incident policy.
      try {
        incident = await EnterpriseIncidentEngineService.createIncident({
          sourceModule: "AIOrchestration",
          category: "Flight",
          type: "AI Plan Partial Failure — Manual Review Required",
          severity: "Medium",
          title: `AI plan ${execution.correlationId}: flight proposal needs manual review`,
          description: reason
        }, tenantId, branchId, userId);
      } catch (err) {
        logger.error("AI compensation incident creation error.", { error: err.message });
      }

      if (approvalRequest && incident) approvalRequest.compensationFlag.relatedIncidentId = incident._id;
      if (approvalRequest) await approvalRequest.save();
    }

    // EXT-036 §14/§24 "Compensation ... Monitoring — Compensations." A real,
    // persisted event on the execution itself (not just the approval
    // request's own flag) — this is what lets getWorkflowMetrics report a
    // genuine compensationsFlagged count instead of nothing at all. Pushed
    // onto the in-memory `execution` here; persisted by executePlan's own
    // save() further down its normal-completion path (this method always
    // runs before that save).
    execution.compensationEvents.push({
      stepNumber: flightProposalStep.stepNumber, relatedStepNumber: hotelFailureStep.stepNumber, reason,
      approvalRequestId: approvalRequest?._id || null, incidentId: incident?._id || null, flaggedAt: new Date()
    });

    publishEvent("AIExecutionCompensationFlagged", {
      executionId: execution._id, tenantId, approvalRequestId: approvalRequest?._id || null, incidentId: incident?._id || null,
      flightStepNumber: flightProposalStep.stepNumber, hotelStepNumber: hotelFailureStep.stepNumber
    });
    publishEvent("NotificationRequested", {
      tenantId, branchId, event: "AIFlightProposalNeedsManualReview", priority: "high",
      approvalRequestId: approvalRequest?._id || null, incidentId: incident?._id || null, executionId: execution._id
    });
  }

  /**
   * "POST /ai/tools/execute" — Load Plan → Validate Permissions → Inject
   * Context → Execute Tools (parallel where the plan marks it, sequential
   * otherwise, with tool-level retry) → Collect Responses → Validate
   * Results → Generate Final Response → Audit.
   */
  static async executePlan({ tenantId, branchId, userId, userName, permissions, role, executionId, isRecoveryResume = false, requestId = null }) {
    // EXT-036 §23 "Idempotency ... Duplicate executions ignored safely." A
    // plain findOne-then-save has a real race: two concurrent calls (e.g. a
    // double-submitted "Execute" click) can both read status "planned"
    // before either one writes "executing", and both then run the whole
    // plan. findOneAndUpdate's filter+update is atomic at the DB layer —
    // only one concurrent caller can ever win the "planned" -> "executing"
    // transition for a given executionId. Recovery-resume doesn't need this
    // same atomic claim: recoverStuckExecutions() only ever runs its sweep
    // loop sequentially within a single process, so no two resumes of the
    // same execution can race within one instance (multi-instance
    // horizontal scaling isn't implemented anywhere in this codebase yet —
    // see utils/eventBus.js's own "single instance" caveat).
    let execution;
    if (isRecoveryResume) {
      execution = await AIToolExecutionModel.findOne({ _id: executionId, tenantId, userId, status: "executing" });
      if (!execution) throw new Error("Execution is not eligible for crash recovery (not found, or no longer 'executing').");
    } else {
      execution = await AIToolExecutionModel.findOneAndUpdate(
        { _id: executionId, tenantId, userId, status: "planned" },
        { $set: { status: "executing", executionStartedAt: new Date() } },
        { new: true }
      );
      if (!execution) {
        const existing = await AIToolExecutionModel.findOne({ _id: executionId, tenantId, userId }).select("status").lean();
        if (!existing) throw new Error("Execution plan not found.");
        throw new Error(`Execution is already '${existing.status}' and cannot be re-executed.`);
      }
    }

    const startedAt = execution.executionStartedAt.getTime();
    // EXT-032 §9 — read back the flag persisted at plan-creation time so
    // AIToolRegistry.execute's own defense-in-depth check applies exactly
    // the same way here as it does for a live conversational turn.
    const context = { tenantId, branchId, userId, userName, permissions, role, executionId: execution._id.toString(), conversationId: execution.conversationId, promptInjectionFlagged: Boolean(execution.promptInjectionFlagged) };

    // EXT-028 §16 "Memory Integration" — loaded once up front (not
    // per-group) and mutated in-memory as steps succeed; persisted once at
    // the end (both the normal-completion and cancellation exit paths) so
    // a formal plan's real results (selected flight/hotel, search params)
    // feed back into the same session memory AIAssistantService.chat()
    // reads/writes, instead of being two disconnected memories.
    let sessionConversation = null;
    let sessionMemory = null;
    let sessionMemoryChanged = false;
    if (execution.conversationId) {
      sessionConversation = await AIConversationModel.findById(execution.conversationId);
      if (sessionConversation) sessionMemory = this._deriveSessionMemory(sessionConversation);
    }

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

    // "Checkpoints ... Recovery starts from latest checkpoint" / "Idempotency
    // ... Duplicate executions ignored safely." Seed the accumulator from
    // whatever this execution already has recorded — empty on a fresh run,
    // populated on a resume. Only a step that already SUCCEEDED is skipped;
    // a previously-failed step gets a fresh attempt (its own handler either
    // never had a side effect, or — for the one class of tool that does,
    // propose_*, whose retry policy is already non-retryable — failed before
    // creating anything). This is what prevents a resumed
    // propose_flight_booking step from creating a second duplicate approval
    // request for the same plan.
    const toolExecutions = (execution.toolExecutions || []).map((t) => (t.toObject ? t.toObject() : t));
    const doneStepNumbers = new Set(toolExecutions.filter((t) => t.succeeded).map((t) => t.stepNumber));
    let hasApprovalPending = toolExecutions.some((t) => t.succeeded && AIToolRegistry.getTool(t.toolName)?.requiresApproval);

    const { toolDefaultTimeoutMs } = getAIConfig();

    const runStep = async (step) => {
      const tool = AIToolRegistry.getTool(step.toolName);
      const retryPolicy = tool ? AIToolRegistry.getRetryPolicy(tool) : { retryable: false, maxRetries: 0 };
      let attempt = 0;
      let outcome;
      const stepStart = Date.now();

      // Per-step, not shared on the outer `context` object — steps in the
      // same parallelGroup run concurrently via Promise.allSettled, so
      // mutating one shared context per step would race.
      const stepContext = { ...context, idempotencyKey: step.idempotencyKey || null };

      do {
        if (attempt > 0) await sleep(backoffDelayMs(attempt - 1));
        try {
          // withTimeout races the call, it doesn't abort it — a losing
          // call may still complete in the background with a real side
          // effect (same honest limitation as EXT-028's cancellation: no
          // tool here has an AbortController wired through it). For the
          // one class of tool with a genuine side effect, propose_*, this
          // is exactly why EXT-036 §23's idempotency key exists — a
          // late-completing proposal call still lands on the same key, so
          // a subsequent real attempt (this step's own retry, or a later
          // resume) can never create a duplicate approval request from it.
          outcome = await withTimeout(AIToolRegistry.execute(step.toolName, step.arguments, stepContext), toolDefaultTimeoutMs, step.toolName);
        } catch (err) {
          outcome = { error: err.message };
        }
        if (!outcome.error) break;
        attempt += 1;
      } while (retryPolicy.retryable && isRetryableError(outcome.error) && attempt <= retryPolicy.maxRetries);

      // Supersede any stale record from a prior (crashed) attempt at this
      // same step rather than appending a duplicate.
      const priorIndex = toolExecutions.findIndex((t) => t.stepNumber === step.stepNumber);
      if (priorIndex !== -1) toolExecutions.splice(priorIndex, 1);
      // EXT-032 §8 "Sensitive Data Protection" — step.arguments (the REAL,
      // unmasked data) was already used for the actual execute() call
      // above; only a masked copy is persisted into toolExecutions, which
      // is display/status history, never re-read as input to any further
      // action (the operative source for a resume/retry is always
      // execution.plan[].arguments, left untouched).
      toolExecutions.push({
        stepNumber: step.stepNumber, toolName: step.toolName, arguments: AIGuardrailService.maskSensitiveData(step.arguments),
        succeeded: !outcome.error, state: outcome.error ? "failed" : "completed", retryCount: attempt, durationMs: Date.now() - stepStart,
        startedAt: new Date(stepStart), error: outcome.error || null, idempotencyKey: step.idempotencyKey || null,
        result: outcome.error ? null : AIGuardrailService.maskSensitiveData(outcome.result)
      });
      publishEvent("AIToolExecuted", { executionId: execution._id, tenantId, toolName: step.toolName, succeeded: !outcome.error, retryCount: attempt });

      if (!outcome.error && step.requiresApproval) hasApprovalPending = true;
      if (!outcome.error && sessionMemory) {
        sessionMemoryChanged = AIContextMemory.applyToolExecution(sessionMemory, step.toolName, step.arguments, outcome.result) || sessionMemoryChanged;
      }
      return outcome;
    };

    // EXT-028 §8 "Dependency Rules — Tasks execute only after dependencies
    // complete successfully." A step whose declared dependsOn stepNumbers
    // haven't all succeeded is never attempted at all (no tool call, no
    // cost, no side effect) — it's recorded state:"skipped" instead. This
    // cascades naturally: a step depending on an already-skipped step also
    // fails this check, since "skipped" is not "succeeded".
    const dependenciesSatisfied = (step) => (step.dependsOn || []).every((depStepNumber) => toolExecutions.some((t) => t.stepNumber === depStepNumber && t.succeeded === true));

    /**
     * EXT-036 §10 "Conditional Branching." `runIf.stepNumber` is always
     * also in this step's own `dependsOn` (enforced at plan-creation time),
     * so by the time this runs the referenced step has already succeeded —
     * reads its real, persisted (masked) `result`. A referenced step that
     * somehow has no result recorded (an honest "can't evaluate" edge case,
     * not expected in practice given the dependsOn guarantee) defaults to
     * satisfied — a false skip of real work is worse than a redundant run
     * a tool's own idempotency already guards against.
     */
    const runIfSatisfied = (step) => {
      if (!step.runIf || !step.runIf.field) return true;
      const dep = toolExecutions.find((t) => t.stepNumber === step.runIf.stepNumber && t.succeeded === true);
      if (!dep || dep.result == null || typeof dep.result !== "object") return true;
      return dep.result[step.runIf.field] === step.runIf.equals;
    };

    const { workflowMaxDurationMs } = getAIConfig();
    let haltReason = null;
    for (const group of groups) {
      // EXT-028 §15 "Cancellation" / EXT-029 §6 "Timed Out" — both
      // cooperative, checked at the same checkpoint boundary as everything
      // else. Cancellation needs a re-fetch (not the in-memory `execution`)
      // because the flag is written by a DIFFERENT, concurrent request
      // while this one is mid-flight; the timeout only needs the
      // in-memory `startedAt`, no re-fetch required.
      const cancelCheck = await AIToolExecutionModel.findById(execution._id).select("cancellationRequested").lean();
      if (cancelCheck?.cancellationRequested) {
        haltReason = "cancelled";
        break;
      }
      if (Date.now() - startedAt > workflowMaxDurationMs) {
        haltReason = "timed_out";
        break;
      }

      const pendingSteps = group.filter((s) => !doneStepNumbers.has(s.stepNumber));
      if (pendingSteps.length === 0) continue;

      const runnable = [];
      for (const step of pendingSteps) {
        if (!dependenciesSatisfied(step)) {
          const unmet = (step.dependsOn || []).filter((d) => !toolExecutions.some((t) => t.stepNumber === d && t.succeeded === true));
          const priorIndex = toolExecutions.findIndex((t) => t.stepNumber === step.stepNumber);
          if (priorIndex !== -1) toolExecutions.splice(priorIndex, 1);
          toolExecutions.push({
            stepNumber: step.stepNumber, toolName: step.toolName, arguments: AIGuardrailService.maskSensitiveData(step.arguments),
            succeeded: false, state: "skipped", retryCount: 0, durationMs: 0, startedAt: new Date(),
            error: `Skipped — dependency step(s) ${unmet.join(", ")} did not complete successfully.`, idempotencyKey: step.idempotencyKey || null
          });
          publishEvent("AIToolStepSkipped", { executionId: execution._id, tenantId, toolName: step.toolName, stepNumber: step.stepNumber, unmetDependencies: unmet });
        } else if (!runIfSatisfied(step)) {
          // EXT-036 §10 — dependencies genuinely satisfied, but the
          // declared condition on an earlier step's real result wasn't
          // met: a real conditional skip, not a fabricated "always run".
          const priorIndex = toolExecutions.findIndex((t) => t.stepNumber === step.stepNumber);
          if (priorIndex !== -1) toolExecutions.splice(priorIndex, 1);
          toolExecutions.push({
            stepNumber: step.stepNumber, toolName: step.toolName, arguments: AIGuardrailService.maskSensitiveData(step.arguments),
            succeeded: false, state: "skipped", retryCount: 0, durationMs: 0, startedAt: new Date(),
            error: `Skipped — condition not met: step ${step.runIf.stepNumber}'s '${step.runIf.field}' did not equal the expected value.`, idempotencyKey: step.idempotencyKey || null
          });
          publishEvent("AIToolStepSkipped", { executionId: execution._id, tenantId, toolName: step.toolName, stepNumber: step.stepNumber, unmetCondition: step.runIf });
        } else {
          runnable.push(step);
        }
      }

      if (runnable.length > 1) {
        await Promise.allSettled(runnable.map((step) => runStep(step)));
      } else if (runnable.length === 1) {
        await runStep(runnable[0]);
      }

      // Checkpoint after every group, not just once at the end — a crash
      // here loses at most the in-flight group, not the whole execution.
      execution.toolExecutions = toolExecutions;
      execution.status = "executing";
      await execution.save();
    }

    if (haltReason) {
      // "Stops Pending Tasks -> Keeps Completed Results -> Logs
      // Cancellation/Timeout -> Returns Current Progress." Every plan step
      // that never got a toolExecutions entry (didn't start, wasn't
      // skipped by a dependency check) is recorded with `haltReason` as
      // its state; anything already completed/failed/skipped before the
      // halt was observed is left exactly as it is. No synthesis pass
      // runs — this is a partial, honest snapshot, not a generated final
      // answer.
      const haltErrorMessage = haltReason === "cancelled" ? "Cancelled by user before this step started." : `Execution exceeded the maximum workflow duration (${workflowMaxDurationMs}ms) before this step started.`;
      for (const step of execution.plan) {
        if (!toolExecutions.some((t) => t.stepNumber === step.stepNumber)) {
          toolExecutions.push({
            stepNumber: step.stepNumber, toolName: step.toolName, arguments: AIGuardrailService.maskSensitiveData(step.arguments),
            succeeded: false, state: haltReason === "cancelled" ? "cancelled" : "failed", retryCount: 0, durationMs: 0, startedAt: new Date(),
            error: haltErrorMessage, idempotencyKey: step.idempotencyKey || null
          });
        }
      }
      execution.status = haltReason;
      execution.toolExecutions = toolExecutions;
      execution.totalExecutionTimeMs = Date.now() - startedAt;
      execution.executionErrors = toolExecutions.filter((t) => !t.succeeded && t.state !== "cancelled" && t.state !== "skipped").map((t) => `${t.toolName}: ${t.error}`);
      execution.auditReference = `AUDIT-${execution._id}`;
      await execution.save();

      if (sessionMemoryChanged && sessionConversation) {
        sessionMemory.expiresAt = AIContextMemory.sessionExpiryDate();
        sessionConversation.context = sessionMemory;
        await sessionConversation.save();
      }

      publishEvent(haltReason === "cancelled" ? "AIExecutionCancelled" : "AIExecutionTimedOut", { executionId: execution._id, tenantId, completedSteps: toolExecutions.filter((t) => t.succeeded).length });

      // EXT-033 §6/§8/§9/§15 — recorded on every real exit path, including
      // a cooperative halt (never only the "clean" completion path).
      AIObservabilityService.recordRequestMetric({
        tenantId, branchId, userId, requestId, correlationId: execution.correlationId, type: "plan_execution",
        provider: execution.provider, model: execution.model, durationMs: execution.totalExecutionTimeMs,
        inputTokens: execution.tokenUsage.inputTokens, outputTokens: execution.tokenUsage.outputTokens, totalTokens: execution.tokenUsage.totalTokens,
        estimatedCostUsd: execution.estimatedCostUsd, succeeded: false, status: execution.status,
        errorCategory: haltReason === "cancelled" ? "workflow_error" : "timeout", errorMessage: haltErrorMessage,
        toolCallCount: toolExecutions.length, toolFailureCount: toolExecutions.filter((t) => !t.succeeded).length,
        toolCalls: toolExecutions.map((t) => ({ toolName: t.toolName, succeeded: t.succeeded, durationMs: t.durationMs, retryCount: t.retryCount || 0 })),
        flaggedPromptInjection: Boolean(execution.promptInjectionFlagged)
      });

      return execution;
    }

    // EXT-036 §14 "Compensation" — scoped to the one concrete case this
    // system's plans can actually produce (see _flagFlightForManualReview's
    // docblock for why a full "cancel the flight reservation" compensation
    // isn't applicable here), and to the exact policy decision made for
    // this build: a hotel step failing never auto-cancels a sibling
    // succeeded flight proposal — it only flags it for human review.
    const flightProposalStep = toolExecutions.find((t) => t.toolName === "propose_flight_booking" && t.succeeded);
    const hotelFailureStep = toolExecutions.find((t) => t.toolName === "propose_hotel_booking" && !t.succeeded);
    if (flightProposalStep && hotelFailureStep) {
      await this._flagFlightForManualReview({ tenantId, branchId, userId, execution, flightProposalStep, hotelFailureStep });
    }

    const succeededCount = toolExecutions.filter((t) => t.succeeded).length;
    const errors = toolExecutions.filter((t) => !t.succeeded).map((t) => `${t.toolName}: ${t.error}`);

    // "Generate Final Response" — a real synthesis pass grounded in the
    // actual collected tool results, only when at least one step ran and
    // no approval is blocking the whole answer.
    let finalAnswer = null;
    let synthesisProvider = execution.provider;
    let synthesisModel = execution.model;
    let synthesisFallbackCount = 0;
    let synthesisAbTestId = null;
    let synthesisAbVariant = null;
    let synthesisUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
    if (toolExecutions.length > 0) {
      try {
        const resultsSummary = toolExecutions.map((t) => `Step ${t.stepNumber} (${t.toolName}): ${t.succeeded ? "succeeded" : `failed - ${t.error}`}`).join("\n");
        const { text: synthesisSystemPrompt, versionRef: synthesisVersionRef } = await AIPromptService.composeWorkflowPrompt({
          tenantId, branchId, key: "synthesis", language: "en", variables: { tenantName: tenantId, branchName: branchId }
        });
        const synthesisCallStartedAt = Date.now();
        const llmResult = await AIModelRouterService.route({
          tenantId, branchId, category: "reasoning", correlationId: execution.correlationId,
          messages: [{ role: "user", content: `User's original request: "${execution.prompt}"\n\nTool execution results:\n${resultsSummary}` }],
          tools: [], systemPrompt: synthesisSystemPrompt
        });
        finalAnswer = llmResult.content;
        synthesisProvider = llmResult.provider;
        synthesisModel = llmResult.model;
        synthesisFallbackCount = llmResult.fallbackCount || 0;
        synthesisAbTestId = llmResult.abTestId || null;
        synthesisAbVariant = llmResult.abVariant || null;
        synthesisUsage = {
          inputTokens: llmResult.usage?.prompt_tokens || llmResult.usage?.input_tokens || 0,
          outputTokens: llmResult.usage?.completion_tokens || llmResult.usage?.output_tokens || 0,
          totalTokens: (llmResult.usage?.prompt_tokens || llmResult.usage?.input_tokens || 0) + (llmResult.usage?.completion_tokens || llmResult.usage?.output_tokens || 0)
        };
        if (synthesisVersionRef) {
          AIPromptService.recordUsage({ versionId: synthesisVersionRef.versionId, latencyMs: Date.now() - synthesisCallStartedAt, tokens: synthesisUsage.totalTokens, succeeded: true }).catch(() => {});
        }
      } catch (err) {
        errors.push(`synthesis: ${err.message}`);
      }
    }

    const status = hasApprovalPending ? "awaiting_approval" : (succeededCount === 0 && toolExecutions.length > 0 ? "failed" : "completed");

    execution.status = status;
    execution.toolExecutions = toolExecutions;
    execution.finalAnswer = finalAnswer;
    execution.provider = synthesisProvider;
    execution.model = synthesisModel;
    execution.tokenUsage = {
      inputTokens: execution.tokenUsage.inputTokens + synthesisUsage.inputTokens,
      outputTokens: execution.tokenUsage.outputTokens + synthesisUsage.outputTokens,
      totalTokens: execution.tokenUsage.totalTokens + synthesisUsage.totalTokens
    };
    // "Cost Optimization" — real per-token math against the Model Router's
    // own configured, labeled-as-estimated rate for whichever provider
    // actually answered.
    const rates = getAIModelConfig().providers[synthesisProvider]?.costPerThousandTokens || { input: 0, output: 0 };
    execution.estimatedCostUsd = Number((
      (execution.tokenUsage.inputTokens / 1000) * rates.input +
      (execution.tokenUsage.outputTokens / 1000) * rates.output
    ).toFixed(6));
    execution.totalExecutionTimeMs = Date.now() - startedAt;
    execution.executionErrors = errors;
    execution.auditReference = `AUDIT-${execution._id}`;
    await execution.save();

    if (sessionMemoryChanged && sessionConversation) {
      sessionMemory.expiresAt = AIContextMemory.sessionExpiryDate();
      sessionConversation.context = sessionMemory;
      await sessionConversation.save();
      publishEvent("AIContextUpdated", { conversationId: sessionConversation._id, tenantId, summary: AIContextMemory.describeForPrompt(sessionMemory) });
    }

    if (status === "failed") {
      publishEvent("AIExecutionFailed", { executionId: execution._id, tenantId, errors });
    } else {
      publishEvent("AIExecutionCompleted", { executionId: execution._id, tenantId, status, toolsUsed: toolExecutions.map((t) => t.toolName) });
    }

    if (mongoose.connection?.readyState === 1) {
      AuditLogModel.create({
        tenantId, userId, action: "AI_EXECUTE_PLAN", module: "AIOrchestration",
        targetId: execution._id.toString(), details: { status, toolsUsed: toolExecutions.map((t) => t.toolName), estimatedCostUsd: execution.estimatedCostUsd }
      }).catch((err) => logger.error("AI orchestration audit log error.", { error: err.message }));
    }

    // EXT-033 §6/§8/§10/§15/§21 — recorded on this, the "clean" exit path
    // (completed/failed/awaiting_approval). `awaiting_approval` is
    // recorded as succeeded=true — a workflow correctly pausing for a
    // required human decision is not itself a failure.
    AIObservabilityService.recordRequestMetric({
      tenantId, branchId, userId, requestId, correlationId: execution.correlationId, type: "plan_execution",
      provider: synthesisProvider, model: synthesisModel, modelFallbackCount: synthesisFallbackCount, abTestId: synthesisAbTestId, abVariant: synthesisAbVariant,
      durationMs: execution.totalExecutionTimeMs,
      inputTokens: execution.tokenUsage.inputTokens, outputTokens: execution.tokenUsage.outputTokens, totalTokens: execution.tokenUsage.totalTokens,
      estimatedCostUsd: execution.estimatedCostUsd, succeeded: status !== "failed", status,
      errorCategory: status === "failed" && errors.length > 0 ? AIObservabilityService.classifyError(errors[0]) : null,
      errorMessage: status === "failed" && errors.length > 0 ? errors.join("; ").slice(0, 500) : null,
      toolCallCount: toolExecutions.length, toolFailureCount: toolExecutions.filter((t) => !t.succeeded).length,
      toolCalls: toolExecutions.map((t) => ({ toolName: t.toolName, succeeded: t.succeeded, durationMs: t.durationMs, retryCount: t.retryCount || 0 })),
      flaggedPromptInjection: Boolean(execution.promptInjectionFlagged)
    });

    return execution;
  }

  /**
   * EXT-028 §15 "Cancellation — Users may cancel execution anytime ...
   * Stops Pending Tasks -> Keeps Completed Results -> Logs Cancellation ->
   * Returns Current Progress." An execution still "planned" or paused
   * "awaiting_approval" has nothing in flight, so it's cancelled
   * immediately. An "executing" one is cancelled cooperatively — this only
   * sets the flag the running executePlan() call checks at its next group
   * boundary (see the checkpoint loop); an already-running group's in-flight
   * tool call(s) still complete before the cancellation takes effect, since
   * there's no safe way to abort an arbitrary in-progress provider call
   * this codebase's tools don't wire an AbortController through.
   */
  static async cancelExecution({ tenantId, userId, executionId, reason }) {
    const execution = await AIToolExecutionModel.findOne({ _id: executionId, tenantId, userId });
    if (!execution) throw new Error("Execution not found.");
    // EXT-036 — fixed a real pre-existing gap: "timed_out" and "archived"
    // were missing from this terminal-status guard, meaning a call here
    // against an already-timed-out execution fell through every branch
    // below into the final unconditional block and silently overwrote its
    // real timed_out state with "cancelled".
    if (["completed", "failed", "cancelled", "rejected", "timed_out", "archived"].includes(execution.status)) {
      throw new Error(`Execution is already '${execution.status}' and cannot be cancelled.`);
    }

    if (execution.status === "executing") {
      execution.cancellationRequested = true;
      execution.cancelReason = reason || null;
      execution.cancelledBy = userId;
      execution.cancelledAt = new Date();
      await execution.save();
      publishEvent("AIExecutionCancellationRequested", { executionId: execution._id, tenantId });
      return execution;
    }

    execution.status = "cancelled";
    execution.cancelReason = reason || null;
    execution.cancelledBy = userId;
    execution.cancelledAt = new Date();
    await execution.save();
    publishEvent("AIExecutionCancelled", { executionId: execution._id, tenantId, completedSteps: (execution.toolExecutions || []).filter((t) => t.succeeded).length });
    return execution;
  }

  /**
   * EXT-036 §5/§21 "Archived" — a real terminal state, mirroring
   * AIAssistantService.archiveConversation's exact pattern (manual only, no
   * automated retention sweep — this codebase's own conversationRetentionDays
   * config has never had a real sweep consumer either, so this doesn't
   * invent one where none of its siblings have one). Only a genuinely
   * finished execution can be archived — "planned"/"executing"/
   * "awaiting_approval" have real outstanding work or a pending human
   * decision, archiving those would hide it, not record history.
   */
  static async archiveExecution({ tenantId, userId, executionId }) {
    const execution = await AIToolExecutionModel.findOne({ _id: executionId, tenantId, userId });
    if (!execution) throw new Error("Execution not found.");
    if (execution.archivedAt) throw new Error("Execution is already archived.");
    const terminalStatuses = ["completed", "failed", "cancelled", "rejected", "timed_out"];
    if (!terminalStatuses.includes(execution.status)) {
      throw new Error(`Execution is '${execution.status}' and cannot be archived — only a finished execution (${terminalStatuses.join(", ")}) may be archived.`);
    }
    // Deliberately does NOT overwrite `status` — that's this execution's
    // real, meaningful outcome (completed/failed/cancelled/rejected/
    // timed_out), and getWorkflowMetrics' statusBreakdown depends on it
    // staying accurate. Archival is orthogonal: `archivedAt` alone is the
    // real signal, so an archived execution still honestly reports what
    // actually happened to it, just flagged as put away.
    execution.archivedAt = new Date();
    await execution.save();
    publishEvent("AIExecutionArchived", { executionId: execution._id, tenantId, originalStatus: execution.status });
    return execution;
  }

  /**
   * EXT-028 §10/§14 "Execution Monitoring" / "Progress Reporting." Derived
   * purely from `plan` + `toolExecutions`, never a separately-tracked
   * counter that could drift. A step with no toolExecutions entry yet is
   * "pending" — that IS its representation; this codebase has no live
   * visibility into which specific step is mid-flight from outside the
   * request that's running it (a synchronous checkpoint-per-group
   * architecture, not a separate worker process), so this deliberately
   * does not claim a "running" count — reporting one would be a guess, not
   * a real signal.
   */
  static computeProgress(execution) {
    const totalSteps = execution.plan?.length || 0;
    const byStepNumber = new Map((execution.toolExecutions || []).map((t) => [t.stepNumber, t]));
    let completedSteps = 0, failedSteps = 0, skippedSteps = 0, cancelledSteps = 0, pendingSteps = 0;
    for (const step of execution.plan || []) {
      const record = byStepNumber.get(step.stepNumber);
      if (!record) { pendingSteps += 1; continue; }
      if (record.state === "skipped") skippedSteps += 1;
      else if (record.state === "cancelled") cancelledSteps += 1;
      else if (record.succeeded) completedSteps += 1;
      else failedSteps += 1;
    }
    const resolvedSteps = completedSteps + failedSteps + skippedSteps + cancelledSteps;
    const percentComplete = totalSteps === 0 ? 100 : Math.round((resolvedSteps / totalSteps) * 100);
    return { status: execution.status, totalSteps, completedSteps, failedSteps, skippedSteps, cancelledSteps, pendingSteps, percentComplete, awaitingApproval: execution.status === "awaiting_approval" };
  }

  /**
   * EXT-036 §22 "Recovery — Server Restart → Load Workflow State → Resume
   * From Checkpoint → Continue Execution. No completed task executes
   * twice." Finds executions the runtime itself abandoned mid-flight — a
   * server crash/restart leaves `status: "executing"` with no further
   * checkpoint saves coming, so `updatedAt` goes stale — and resumes each
   * one through the same `executePlan` path (skipping steps already
   * checkpointed as succeeded). Called by `aiWorkflowRecoveryScheduler.js`
   * on a cron sweep; also safely callable directly (e.g. from a
   * maintenance script) since it's idempotent — an execution already
   * resumed and finalized by an earlier sweep no longer matches the
   * `status: "executing"` query.
   */
  static async recoverStuckExecutions() {
    if (mongoose.connection?.readyState !== 1) return { scanned: 0, recovered: 0, failed: 0 };

    const { staleExecutionThresholdMs } = getAIWorkflowRecoveryConfig();
    const staleBefore = new Date(Date.now() - staleExecutionThresholdMs);

    const stuckExecutions = await AIToolExecutionModel.find({
      status: "executing",
      updatedAt: { $lte: staleBefore }
    }).limit(50);

    let recovered = 0;
    let failed = 0;

    for (const execution of stuckExecutions) {
      publishEvent("AIExecutionRecoveryStarted", { executionId: execution._id, tenantId: execution.tenantId, correlationId: execution.correlationId });
      // EXT-036 §22 "Recovery" — real, honest traceability written BEFORE
      // the resume attempt (not after), so even an execution that ends up
      // failing during recovery still honestly shows it was attempted.
      await AIToolExecutionModel.updateOne({ _id: execution._id }, { $inc: { recoveryCount: 1 }, $set: { lastRecoveredAt: new Date() } }).catch((err) => logger.error("AI recovery-counter update error.", { error: err.message }));
      try {
        await this.executePlan({
          tenantId: execution.tenantId,
          branchId: execution.branchId,
          userId: execution.userId,
          userName: execution.userName,
          role: execution.role,
          permissions: execution.permissions || [],
          executionId: execution._id.toString(),
          isRecoveryResume: true
        });
        recovered += 1;
      } catch (err) {
        failed += 1;
        // A resume attempt that itself throws (e.g. a stale plan whose
        // tools no longer exist) must not be left to retry forever on
        // every future sweep — mark it terminally failed for a human to
        // investigate via the existing execution/audit views.
        execution.status = "failed";
        execution.executionErrors = [...(execution.executionErrors || []), `recovery failed: ${err.message}`];
        await execution.save().catch((saveErr) => logger.error("AI recovery failure-state save error.", { error: saveErr.message }));
        publishEvent("AIExecutionRecoveryFailed", { executionId: execution._id, tenantId: execution.tenantId, error: err.message });
      }
    }

    return { scanned: stuckExecutions.length, recovered, failed };
  }

  /** "POST /ai/tools/approval" — never executes the proposed action itself; hands back the real endpoint call for a human/UI to invoke. */
  static async decideApproval({ tenantId, userId, userName, role, permissions, approvalRequestId, decision, reason }) {
    if (!["approve", "reject"].includes(decision)) throw new Error("decision must be 'approve' or 'reject'.");
    const request = await AIApprovalRequestModel.findOne({ _id: approvalRequestId, tenantId });
    if (!request) throw new Error("Approval request not found.");
    if (request.status !== "pending") throw new Error(`Approval request is already '${request.status}'.`);

    const hasRole = (role && role.toLowerCase() === request.requiredRole.toLowerCase()) || permissions.includes("admin") || permissions.includes("superadmin");
    if (!hasRole) {
      // EXT-033 §23 "Security Monitoring — Approval Violations." A real
      // event so an attempt to decide an approval without the required
      // role is actually counted (see
      // AIObservabilityService.getSecurityMetrics), not just thrown away
      // as an ordinary 403.
      publishEvent("AIApprovalRoleViolation", { tenantId, userId, approvalRequestId: request._id, toolName: request.toolName, requiredRole: request.requiredRole, actualRole: role || null });
      throw new Error(`Only a user with role '${request.requiredRole}' (or admin) can decide this approval request.`);
    }

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
      }).catch((err) => logger.error("AI approval audit log error.", { error: err.message }));
    }

    // EXT-029 §7/§10/§14 "Workflow Lifecycle ... Waiting Event -> Resume"
    // / "Workflow resumes automatically." Previously a human's decision
    // only ever updated THIS approval row — the linked execution stayed at
    // status "awaiting_approval" forever, even after every approval tied
    // to it was resolved. There's no remaining tool work to actually
    // re-run here (the propose_* tool already ran and succeeded, creating
    // this very approval) — "resuming" means finalizing the execution's
    // own status once every approval it's waiting on has a real decision.
    if (request.executionId) {
      const execution = await AIToolExecutionModel.findOne({ _id: request.executionId, tenantId });
      if (execution && execution.status === "awaiting_approval") {
        const stillPending = await AIApprovalRequestModel.exists({ executionId: request.executionId, tenantId, status: "pending" });
        if (!stillPending) {
          // "completed" reflects that no further human action is pending —
          // each individual approval's own approved/rejected outcome
          // remains the authoritative record; the execution-level status
          // doesn't re-encode a compound approved+rejected mix.
          execution.status = "completed";
          await execution.save();
          publishEvent("AIExecutionCompleted", { executionId: execution._id, tenantId, status: "completed", resolvedViaApproval: true });
        }
      }
    }

    return {
      approvalRequestId: request._id,
      status: request.status,
      // Only surfaced on approval — this is the hand-off, not an execution.
      proposedAction: request.status === "approved" ? request.proposedAction : null
    };
  }

  /**
   * EXT-029 §18 / EXT-036 §24 "Monitoring — Running Workflows, Failed
   * Workflows, Average Duration, Retries, Timeouts, Compensations, Approval
   * Delays, Provider Failures, Worker Utilization." Real DB aggregation
   * over this tenant's own AIToolExecutionModel/AIApprovalRequestModel
   * rows — never a fabricated or cached number. "Worker Utilization" is
   * deliberately absent: this codebase has no separate worker pool
   * (execution runs synchronously within the request/sweep that calls
   * executePlan()), so there is nothing real to report for it. "Queue
   * Length" (EXT-036 §24/§21) is likewise absent for the same reason — no
   * real distributed queue exists to measure. "Provider Failures" is
   * likewise not separately broken out here — GdsIntegrationService's own
   * circuit breaker state (GET /api/v1/integrations/amadeus/metrics) is
   * already the real provider-level signal; duplicating it from tool-call
   * error strings here would be a guess, not a measurement.
   * `compensationsFlagged`/`recoveredWorkflows`/`archivedWorkflows` are the
   * real, previously-untracked EXT-036 additions.
   */
  static async getWorkflowMetrics({ tenantId }) {
    if (mongoose.connection?.readyState !== 1) {
      return { totalExecutions: 0, statusBreakdown: {}, runningWorkflows: 0, failedWorkflows: 0, timedOutWorkflows: 0, cancelledWorkflows: 0, awaitingApprovalWorkflows: 0, averageDurationMs: null, totalRetries: 0, compensationsFlagged: 0, recoveredWorkflows: 0, archivedWorkflows: 0, approvalDelay: { averageDecisionDelayMs: null, decidedCount: 0, pendingCount: 0 } };
    }

    const [facetResult] = await AIToolExecutionModel.aggregate([
      { $match: { tenantId } },
      { $facet: {
        byStatus: [{ $group: { _id: "$status", count: { $sum: 1 } } }],
        durations: [
          { $match: { status: { $in: ["completed", "failed", "cancelled", "timed_out", "rejected"] } } },
          { $group: { _id: null, avgDurationMs: { $avg: "$totalExecutionTimeMs" } } }
        ],
        retries: [
          { $unwind: { path: "$toolExecutions", preserveNullAndEmptyArrays: false } },
          { $group: { _id: null, totalRetries: { $sum: "$toolExecutions.retryCount" } } }
        ],
        // EXT-036 §24 "Monitoring — Compensations." Real count of
        // executions carrying at least one real compensationEvents entry
        // (see _flagFlightForManualReview) — the genuine gap this document
        // closes; nothing tracked this at all before.
        compensations: [
          { $match: { "compensationEvents.0": { $exists: true } } },
          { $count: "count" }
        ],
        // §22 "Recovery." Real count of executions the crash-recovery
        // sweep has genuinely had to resume at least once.
        recovered: [
          { $match: { recoveryCount: { $gt: 0 } } },
          { $count: "count" }
        ],
        // §5/§21 "Archived." Real count — archival is orthogonal to the
        // execution's own outcome status (see archiveExecution's docblock),
        // so this is counted separately, not folded into statusBreakdown.
        archived: [
          { $match: { archivedAt: { $ne: null } } },
          { $count: "count" }
        ]
      } }
    ]);

    const statusBreakdown = {};
    let totalExecutions = 0;
    for (const row of facetResult?.byStatus || []) {
      statusBreakdown[row._id] = row.count;
      totalExecutions += row.count;
    }

    const [decidedAgg, pendingCount] = await Promise.all([
      AIApprovalRequestModel.aggregate([
        { $match: { tenantId, status: { $ne: "pending" }, decidedAt: { $ne: null } } },
        { $project: { decisionDelayMs: { $subtract: ["$decidedAt", "$createdAt"] } } },
        { $group: { _id: null, avgDecisionDelayMs: { $avg: "$decisionDelayMs" }, count: { $sum: 1 } } }
      ]),
      AIApprovalRequestModel.countDocuments({ tenantId, status: "pending" })
    ]);

    return {
      tenantId,
      totalExecutions,
      statusBreakdown,
      runningWorkflows: statusBreakdown.executing || 0,
      failedWorkflows: statusBreakdown.failed || 0,
      timedOutWorkflows: statusBreakdown.timed_out || 0,
      cancelledWorkflows: statusBreakdown.cancelled || 0,
      awaitingApprovalWorkflows: statusBreakdown.awaiting_approval || 0,
      averageDurationMs: facetResult?.durations?.[0]?.avgDurationMs != null ? Math.round(facetResult.durations[0].avgDurationMs) : null,
      totalRetries: facetResult?.retries?.[0]?.totalRetries || 0,
      compensationsFlagged: facetResult?.compensations?.[0]?.count || 0,
      recoveredWorkflows: facetResult?.recovered?.[0]?.count || 0,
      archivedWorkflows: facetResult?.archived?.[0]?.count || 0,
      approvalDelay: {
        averageDecisionDelayMs: decidedAgg?.[0]?.avgDecisionDelayMs != null ? Math.round(decidedAgg[0].avgDecisionDelayMs) : null,
        decidedCount: decidedAgg?.[0]?.count || 0,
        pendingCount
      }
    };
  }

  static async listExecutions({ tenantId, userId, page = 1, pageSize = 20 }) {
    const safePage = Math.max(parseInt(page, 10) || 1, 1);
    const safePageSize = Math.min(Math.max(parseInt(pageSize, 10) || 20, 1), 100);
    const filter = { tenantId, userId };
    const [items, totalItems] = await Promise.all([
      AIToolExecutionModel.find(filter).sort({ createdAt: -1 }).skip((safePage - 1) * safePageSize).limit(safePageSize)
        .select("status prompt provider tokenUsage estimatedCostUsd totalExecutionTimeMs createdAt correlationId archivedAt recoveryCount").lean(),
      AIToolExecutionModel.countDocuments(filter)
    ]);
    return { items, pagination: { page: safePage, pageSize: safePageSize, totalItems, totalPages: Math.ceil(totalItems / safePageSize) || 1 } };
  }

  static async getExecutionById({ tenantId, userId, executionId }) {
    const execution = await AIToolExecutionModel.findOne({ _id: executionId, tenantId, userId }).lean();
    if (!execution) throw new Error("Execution not found.");
    return { ...execution, progress: this.computeProgress(execution) };
  }

  /** EXT-034 — delegates to the single shared Model Router; no longer this service's own adapter map/circuit breaker. */
  static async getProviderStatus() {
    return AIModelRouterService.getProviderStatus();
  }
}

export default AIOrchestrationService;
