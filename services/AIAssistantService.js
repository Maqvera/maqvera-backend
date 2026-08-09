import mongoose from "mongoose";
import AIConversationModel from "../models/AIConversationModel.js";
import AuditLogModel from "../models/AuditLogmodel.js";
import AIToolRegistry from "./ai/AIToolRegistry.js";
import AIAgentRegistry from "./ai/AIAgentRegistry.js";
import AIRankingService from "./ai/AIRankingService.js";
import AIContextMemory from "./ai/AIContextMemory.js";
import AIPromptService from "./AIPromptService.js";
import AIGuardrailService from "./ai/AIGuardrailService.js";
import AIObservabilityService from "./ai/AIObservabilityService.js";
import AIModelRouterService from "./ai/AIModelRouterService.js";
import { getAIConfig } from "../utils/aiConfig.js";
import { getAIModelConfig } from "../utils/aiModelConfig.js";
import { publishEvent } from "../utils/eventBus.js";
import logger from "../utils/logger.js";

class AIAssistantService {
  /**
   * "Prompt Injection Protection" — a bounded, honest heuristic, not a
   * claim of foolproof detection. EXT-032 centralized the actual pattern
   * list/matching into AIGuardrailService (the single source of truth also
   * used by AIOrchestrationService.createPlan and by the Policy Engine's
   * own defense-in-depth block); this method is kept as a thin delegate so
   * every existing call site (`this.detectPromptInjection(...)`) is
   * unaffected.
   */
  static detectPromptInjection(message) {
    return AIGuardrailService.detectPromptInjection(message);
  }

  /**
   * "AI Architecture: AI Gateway → Prompt Orchestrator → Context Builder →
   * Permission Validator → Tool Router → Enterprise APIs → LLM → Response
   * Validator". `forcedToolName` lets the dedicated endpoints
   * (/ai/flight-search, /ai/hotel-search, ...) bias tool selection toward
   * their named capability without hand-rolling a duplicate pipeline.
   *
   * EXT-033 "AI Observability" — a thin public wrapper around the real
   * logic in `_chatCore` so BOTH the success path (recorded inside
   * `_chatCore`, which has all the detail) and the failure path (recorded
   * here, since a thrown error can originate before `_chatCore` builds any
   * of that detail — e.g. AI_UNAVAILABLE) write a real
   * AIRequestMetricModel row, without changing this method's existing
   * external contract (same params in, same return shape or thrown error
   * out).
   */
  static async chat(params) {
    const startedAt = Date.now();
    try {
      return await this._chatCore(params);
    } catch (err) {
      AIObservabilityService.recordRequestMetric({
        tenantId: params.tenantId, userId: params.userId,
        requestId: params.requestId || null, correlationId: params.conversationId || null, type: "chat",
        durationMs: Date.now() - startedAt, succeeded: false, status: "failed",
        errorCategory: AIObservabilityService.classifyError(err.message), errorMessage: err.message,
        flaggedPromptInjection: this.detectPromptInjection(params.message || "")
      });
      logger.error("AIAssistantService.chat failed.", { tenantId: params.tenantId, userId: params.userId, error: err.message });
      throw err;
    }
  }

  static async _chatCore({ tenantId, userId, userName = "User", permissions = [], role, message, conversationId = null, mode = "Assistant", forcedToolName = null, agentId = null, requestId = null }) {
    const turnStartedAt = Date.now();
    const config = getAIConfig();
    if (!message || !message.trim()) {
      throw new Error("message is required.");
    }
    if (message.length > config.maxMessageLength) {
      throw new Error(`message exceeds the maximum allowed length of ${config.maxMessageLength} characters.`);
    }

    const flaggedInjection = this.detectPromptInjection(message);

    let conversation = conversationId
      ? await AIConversationModel.findOne({ _id: conversationId, tenantId, userId })
      : null;
    const isNewConversation = !conversation;
    if (!conversation) {
      conversation = new AIConversationModel({ tenantId, userId, mode, messages: [], toolExecutions: [] });
      publishEvent("AIConversationStarted", { conversationId: conversation._id, tenantId, userId, mode });
    }

    conversation.messages.push({ role: "user", content: message });
    if (flaggedInjection) conversation.flaggedPromptInjection = true;

    // EXT-027 "AI Agent Memory & Conversation Context" — session-scoped
    // structured memory, separate from the raw `messages` transcript above.
    // A conversation created before this field existed, or a session whose
    // memory already expired (lazy check here, in addition to the
    // scheduled sweep in aiContextExpiryScheduler.js), starts from a clean
    // slate rather than reusing stale/absent data.
    const storedContext = conversation.context?.toObject ? conversation.context.toObject() : conversation.context;
    const contextExpired = storedContext?.expiresAt && new Date(storedContext.expiresAt).getTime() < Date.now();
    const sessionMemory = (storedContext && storedContext.flight && !contextExpired) ? storedContext : AIContextMemory.empty();
    const memorySummaryBefore = AIContextMemory.describeForPrompt(sessionMemory);

    // EXT-032 §9 "Prompt injection detected before execution" — carried
    // through to AIToolRegistry.execute, which refuses any non-read tool
    // for the rest of this turn when set (defense-in-depth, independent of
    // tenant policy configuration).
    const context = { tenantId, userId, userName, permissions, role, conversationId: conversation._id?.toString(), executionId: null, promptInjectionFlagged: flaggedInjection };
    publishEvent("AIContextLoaded", { conversationId: conversation._id, tenantId, sources: memorySummaryBefore ? ["conversation-history", "session-memory"] : ["conversation-history"], hasMemory: Boolean(memorySummaryBefore) });

    // EXT-035 §9/§12 "Agent Discovery" / "Least privilege enforced" — an
    // optional `agentId` scopes tool visibility to one specialized agent's
    // own real subset (AIAgentRegistry), the same way `forcedToolName`
    // already scopes to a single tool. `forcedToolName` wins when both are
    // given (more specific). An unknown `agentId` is a real caller error,
    // not silently ignored into "full catalog".
    let availableTools;
    if (forcedToolName) {
      availableTools = AIToolRegistry.getSchemas().filter((t) => t.name === forcedToolName);
    } else if (agentId) {
      const agent = AIAgentRegistry.getAgent(agentId);
      if (!agent) throw new Error(`Unknown agentId '${agentId}'.`);
      availableTools = AIAgentRegistry.getToolsForAgent(agentId, permissions).map((t) => ({ name: t.name, description: t.description, parameters: t.parameters }));
    } else {
      availableTools = AIToolRegistry.getSchemas();
    }

    const history = conversation.messages
      .slice(-config.maxHistoryMessages)
      .filter((m) => m.role !== "tool")
      .map((m) => ({ role: m.role, content: m.content }));

    // EXT-031 "AI Prompt Management & System Instructions" — the system
    // prompt is no longer a hardcoded template-literal constant; it's
    // composed from whatever this tenant has published (system + role/mode
    // + guardrail pieces), falling back to the relocated defaults in
    // utils/aiPromptDefaults.js when nothing is published. Composed once
    // per turn (its inputs don't change across tool-calling iterations),
    // reused for every LLM call in the loop below.
    const promptVariables = { tenantName: tenantId, userRole: role || "unknown", language: "en", currentDate: new Date().toISOString().slice(0, 10) };
    const { text: systemPrompt, versionRefs: promptVersionRefs } = await AIPromptService.composeChatPrompt({
      tenantId, mode, role, language: "en", variables: promptVariables, memorySummary: memorySummaryBefore
    });

    const toolExecutionsThisTurn = [];
    // EXT-033 §7/§8/§11/§23 — lightweight parallel bookkeeping purely for
    // the AIRequestMetricModel row recorded at the end of this turn; never
    // exposed in the public return shape.
    const toolCallsForMetric = [];
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let guardrailBlockedCount = 0;
    let ragUsed = false;
    let ragHit = null;
    let ragChunkCount = 0;
    let ragCitationCount = 0;
    let finalAnswer = null;
    let usedProvider = null;
    // EXT-034 "AI Model Management & Multi-LLM Routing" — real router
    // metadata for whichever model actually answered this turn (the LAST
    // LLM call's assignment wins if a multi-iteration tool-calling turn
    // happens to straddle an A/B test — each iteration re-rolls
    // independently, a deliberate, disclosed simplification rather than
    // session-sticky assignment).
    let usedModel = null;
    let totalFallbackCount = 0;
    let usedAbTestId = null;
    let usedAbVariant = null;
    let iterations = 0;
    let memoryChangedThisTurn = false;

    while (iterations < config.maxToolIterations) {
      iterations += 1;
      const llmCallStartedAt = Date.now();
      const llmResult = await AIModelRouterService.route({
        tenantId, category: "general_chat", correlationId: conversation._id?.toString() || null,
        messages: history, tools: availableTools, systemPrompt
      });
      const llmCallLatencyMs = Date.now() - llmCallStartedAt;
      const llmCallInputTokens = llmResult.usage?.prompt_tokens || llmResult.usage?.input_tokens || 0;
      const llmCallOutputTokens = llmResult.usage?.completion_tokens || llmResult.usage?.output_tokens || 0;
      totalInputTokens += llmCallInputTokens;
      totalOutputTokens += llmCallOutputTokens;
      const llmCallTokens = llmCallInputTokens + llmCallOutputTokens;
      // §20 "Monitoring — Execution Count, Average Latency, Token Usage,
      // Success Rate." Only ever recorded against a version this codebase
      // actually resolved from the DB — the hardcoded fallback has no
      // versionId, and correctly gets no usage counter (nothing an admin
      // could act on for content they don't control).
      for (const ref of promptVersionRefs) {
        AIPromptService.recordUsage({ versionId: ref.versionId, latencyMs: llmCallLatencyMs, tokens: llmCallTokens, succeeded: true }).catch(() => {});
      }
      usedProvider = llmResult.provider;
      usedModel = llmResult.model;
      totalFallbackCount += llmResult.fallbackCount || 0;
      usedAbTestId = llmResult.abTestId || null;
      usedAbVariant = llmResult.abVariant || null;

      if (!llmResult.toolCalls || llmResult.toolCalls.length === 0) {
        finalAnswer = llmResult.content || "I was unable to generate a response.";
        break;
      }

      history.push({ role: "assistant", content: llmResult.content || "" });

      for (const call of llmResult.toolCalls) {
        const startedAt = Date.now();
        const outcome = await AIToolRegistry.execute(call.name, call.arguments, context);
        const durationMs = Date.now() - startedAt;
        const succeeded = !outcome.error;

        // EXT-032 §8 "Sensitive Data Protection" — the REAL call.arguments
        // (potentially containing a passport number, etc. for
        // propose_flight_booking) was already handed to
        // AIToolRegistry.execute above, unmasked, since the handler
        // genuinely needs it (e.g. to hand a real passport number to the
        // human approver via proposedAction.body). What gets PERSISTED into
        // the conversation transcript/history — which also feeds back into
        // the LLM's own context on the next turn — is a masked copy only.
        const maskedArguments = AIGuardrailService.maskSensitiveData(call.arguments);
        toolExecutionsThisTurn.push({ toolName: call.name, arguments: maskedArguments, succeeded, durationMs, executedAt: new Date() });
        conversation.messages.push({ role: "tool", toolName: call.name, toolArguments: maskedArguments, content: JSON.stringify(outcome).slice(0, 4000) });
        publishEvent("AIToolExecuted", { conversationId: conversation._id, tenantId, toolName: call.name, succeeded, durationMs });

        // EXT-033 §8/§11/§23 bookkeeping — see this turn's toolCallsForMetric declaration above.
        toolCallsForMetric.push({ toolName: call.name, succeeded, durationMs, retryCount: 0 });
        if (outcome.blocked) guardrailBlockedCount += 1;
        if (call.name === "search_knowledge_base" && succeeded) {
          const citationCount = (outcome.result?.citations || []).length;
          ragUsed = true;
          ragHit = citationCount > 0;
          ragChunkCount = citationCount;
          ragCitationCount = citationCount;
        }

        // EXT-027 §12 "Context Updates ... Only affected context is
        // refreshed." A failed call never overwrites good remembered
        // context with nulls/garbage — only a real, successful tool result
        // updates memory, and only the namespaced section that tool owns.
        if (succeeded) {
          memoryChangedThisTurn = AIContextMemory.applyToolExecution(sessionMemory, call.name, call.arguments, outcome.result) || memoryChangedThisTurn;
        }

        history.push({ role: "user", content: `[Tool result for ${call.name}]: ${JSON.stringify(succeeded ? outcome.result : { error: outcome.error }).slice(0, 4000)}` });
      }
    }

    if (!finalAnswer) {
      finalAnswer = "I gathered some information but could not finish reasoning within the allowed steps. Please refine your question.";
    }

    // EXT-032 §11 "Response Validation — Sensitive Data, Permission
    // Leakage, Hallucination Risk, Policy Compliance." Real checks: refuse
    // to echo the system prompt back verbatim if the model was manipulated
    // into doing so; mask any sensitive-shaped value that slipped into the
    // free-text answer; flag (never silently rewrite) currency amounts the
    // answer states that don't appear anywhere in this turn's actual tool
    // results — a possible fabricated price.
    const toolResultsTextThisTurn = conversation.messages
      .filter((m) => m.role === "tool" && toolExecutionsThisTurn.some((t) => t.toolName === m.toolName))
      .map((m) => m.content).join(" ");
    const responseValidation = AIGuardrailService.validateResponse({ finalAnswer, toolResultsText: toolResultsTextThisTurn });
    finalAnswer = responseValidation.sanitizedAnswer;

    // "Confidence Score" — a real, transparent, deterministic signal
    // (not a fabricated certainty number): grounded answers using
    // successful tool calls score higher than ungrounded free-text answers.
    const successfulTools = toolExecutionsThisTurn.filter((t) => t.succeeded);
    const failedTools = toolExecutionsThisTurn.filter((t) => !t.succeeded);
    let confidenceScore = successfulTools.length > 0 ? 60 : 40;
    confidenceScore += Math.min(successfulTools.length * 10, 30);
    confidenceScore -= failedTools.length * 15;
    confidenceScore = Math.max(0, Math.min(100, confidenceScore));

    const sources = [...new Set(successfulTools.map((t) => t.toolName))];
    // "Structured Outputs" — recommendations come from real tool result
    // data (flight/hotel offers actually returned), never parsed out of
    // free-text prose. EXT-025 §7 "Ranking Strategy" — ranked by
    // AIRankingService (real weighted score over price/duration/stops/
    // refundability/actual requested preferences) rather than just taking
    // whatever order the provider happened to return.
    const recommendations = [];
    for (const exec of toolExecutionsThisTurn) {
      if (!exec.succeeded) continue;
      const msg = conversation.messages.filter((m) => m.role === "tool" && m.toolName === exec.toolName).slice(-1)[0];
      if (!msg) continue;
      try {
        const parsed = JSON.parse(msg.content);
        if (parsed.result?.offers) {
          const ranked = AIRankingService.rankOffers(parsed.result.offers, exec.arguments || {});
          recommendations.push(...ranked.slice(0, 3).map((o) => ({ source: exec.toolName, ...o })));
        }
      } catch { /* non-offer tool result, nothing to add as a recommendation */ }
    }

    // EXT-030 §15 "AI Citations — Document Name, Section, Version,
    // Timestamp, Confidence." Real citations from search_knowledge_base's
    // own result, never derived from the model's free-text answer.
    const citations = [];
    for (const exec of toolExecutionsThisTurn) {
      if (!exec.succeeded || exec.toolName !== "search_knowledge_base") continue;
      const msg = conversation.messages.filter((m) => m.role === "tool" && m.toolName === exec.toolName).slice(-1)[0];
      if (!msg) continue;
      try {
        const parsed = JSON.parse(msg.content);
        if (Array.isArray(parsed.result?.citations)) citations.push(...parsed.result.citations);
      } catch { /* malformed tool result, nothing to cite */ }
    }

    conversation.messages.push({ role: "assistant", content: finalAnswer });
    conversation.toolExecutions.push(...toolExecutionsThisTurn);
    conversation.provider = usedProvider;
    conversation.lastConfidenceScore = confidenceScore;
    conversation.lastSources = sources;
    // EXT-027 §10 "Context Lifecycle" — the session's idle-timeout clock
    // resets on ANY turn (not only one that updated a tracked field), same
    // as a normal session/cache TTL; a scheduled sweep
    // (aiContextExpiryScheduler.js) clears memory that goes idle past this.
    sessionMemory.expiresAt = AIContextMemory.sessionExpiryDate();
    conversation.context = sessionMemory;
    await conversation.save();

    if (memoryChangedThisTurn) {
      publishEvent("AIContextUpdated", { conversationId: conversation._id, tenantId, summary: AIContextMemory.describeForPrompt(sessionMemory) });
    }

    if (recommendations.length > 0) {
      publishEvent("AIRecommendationGenerated", { conversationId: conversation._id, tenantId, count: recommendations.length, sources });
    }

    if (mongoose.connection?.readyState === 1) {
      AuditLogModel.create({
        tenantId, userId, action: "AI_CHAT", module: "AIAssistant",
        details: {
          conversationId: conversation._id.toString(), toolsUsed: sources, flaggedPromptInjection: flaggedInjection, provider: usedProvider,
          systemPromptLeakDetected: responseValidation.systemPromptLeakDetected, sensitiveDataMasked: responseValidation.sensitiveDataMasked
        }
      }).catch((err) => logger.error("AI audit log error.", { error: err.message }));
    }

    // EXT-033 §6/§7/§8/§10/§11/§13/§21 + EXT-034 §14/§20 — the real per-turn
    // observability fact table row. `model`/cost rates come straight from
    // AIModelRouterService's own resolved catalog entry for whichever
    // provider actually answered — real for any provider the router
    // supports, not just the original two.
    const costRates = getAIModelConfig().providers[usedProvider]?.costPerThousandTokens || { input: 0, output: 0 };
    const estimatedCostUsd = Number((((totalInputTokens / 1000) * costRates.input) + ((totalOutputTokens / 1000) * costRates.output)).toFixed(6));
    AIObservabilityService.recordRequestMetric({
      tenantId, userId, requestId, correlationId: conversation._id.toString(), type: "chat",
      provider: usedProvider, model: usedModel, modelFallbackCount: totalFallbackCount, abTestId: usedAbTestId, abVariant: usedAbVariant,
      durationMs: Date.now() - turnStartedAt,
      inputTokens: totalInputTokens, outputTokens: totalOutputTokens, totalTokens: totalInputTokens + totalOutputTokens,
      estimatedCostUsd, succeeded: true, status: "completed",
      toolCallCount: toolCallsForMetric.length, toolFailureCount: toolCallsForMetric.filter((t) => !t.succeeded).length, toolCalls: toolCallsForMetric,
      flaggedPromptInjection: flaggedInjection, guardrailBlockedCount,
      confidenceScore, possiblyUngroundedCount: responseValidation.ungroundedClaims.length,
      ragUsed, ragHit, ragChunkCount, ragCitationCount,
      promptFallbackUsed: promptVersionRefs.length === 0,
      // EXT-035 §20 "Agent Usage" — real, even for the single-agent path:
      // when the caller scoped this turn to one specific agent, tag it so
      // AIObservabilityService.getAgentMetrics can count it alongside
      // Supervisor-coordinated turns. No agentId (full-catalog turn) means
      // no agent to attribute usage to.
      agentIds: agentId ? [agentId] : [], supervisorUsed: false
    });

    return {
      conversationId: conversation._id,
      isNewConversation,
      answer: finalAnswer,
      recommendations,
      citations,
      toolExecutions: toolExecutionsThisTurn,
      confidenceScore,
      possiblyUngroundedClaims: responseValidation.ungroundedClaims,
      sources,
      provider: usedProvider,
      flaggedPromptInjection: flaggedInjection
    };
  }

  static async listConversations({ tenantId, userId, page = 1, pageSize = 20 }) {
    const safePage = Math.max(parseInt(page, 10) || 1, 1);
    const safePageSize = Math.min(Math.max(parseInt(pageSize, 10) || 20, 1), 100);
    const filter = { tenantId, userId };
    const [items, totalItems] = await Promise.all([
      AIConversationModel.find(filter).sort({ updatedAt: -1 }).skip((safePage - 1) * safePageSize).limit(safePageSize)
        .select("mode status lastConfidenceScore lastSources provider createdAt updatedAt messages")
        .lean(),
      AIConversationModel.countDocuments(filter)
    ]);
    return {
      items: items.map((c) => ({
        conversationId: c._id, mode: c.mode, status: c.status, messageCount: c.messages?.length || 0,
        lastConfidenceScore: c.lastConfidenceScore, lastSources: c.lastSources, provider: c.provider,
        createdAt: c.createdAt, updatedAt: c.updatedAt
      })),
      pagination: { page: safePage, pageSize: safePageSize, totalItems, totalPages: Math.ceil(totalItems / safePageSize) || 1 }
    };
  }

  /** "Conversation → Session → Context → Summary → Archive" memory lifecycle. */
  static async archiveConversation({ tenantId, userId, conversationId }) {
    const conversation = await AIConversationModel.findOne({ _id: conversationId, tenantId, userId });
    if (!conversation) throw new Error("Conversation not found.");
    conversation.status = "archived";
    conversation.archivedAt = new Date();
    if (!conversation.summary) {
      const userMessages = conversation.messages.filter((m) => m.role === "user").map((m) => m.content);
      conversation.summary = userMessages.slice(0, 3).join(" | ").slice(0, 500) || "No summary available.";
    }
    await conversation.save();
    publishEvent("AIConversationEnded", { conversationId: conversation._id, tenantId, userId });
    return conversation;
  }

  /** EXT-027 §16 "Manual clear supported" — clears the structured session memory only; the message/tool-execution transcript (and the conversation itself) is untouched, same as automatic expiry (aiContextExpiryScheduler.js). */
  static async clearContext({ tenantId, userId, conversationId }) {
    const conversation = await AIConversationModel.findOne({ _id: conversationId, tenantId, userId });
    if (!conversation) throw new Error("Conversation not found.");
    conversation.context = AIContextMemory.empty();
    await conversation.save();
    publishEvent("AIContextCleared", { conversationId: conversation._id, tenantId, userId, reason: "manual" });
    return conversation;
  }

  /** GET counterpart to clearContext — read-only inspection of the current session memory. */
  static async getContext({ tenantId, userId, conversationId }) {
    const conversation = await AIConversationModel.findOne({ _id: conversationId, tenantId, userId }).select("context").lean();
    if (!conversation) throw new Error("Conversation not found.");
    return conversation.context || AIContextMemory.empty();
  }

  /** EXT-034 — delegates to the single shared Model Router; no longer this service's own adapter map/circuit breaker. */
  static async getProviderStatus() {
    return AIModelRouterService.getProviderStatus();
  }
}

export default AIAssistantService;
