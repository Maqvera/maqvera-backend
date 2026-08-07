import mongoose from "mongoose";
import AIConversationModel from "../../models/AIConversationModel.js";
import AuditLogModel from "../../models/AuditLogmodel.js";
import AIToolRegistry from "./AIToolRegistry.js";
import AIAgentRegistry from "./AIAgentRegistry.js";
import AIRankingService from "./AIRankingService.js";
import AIContextMemory from "./AIContextMemory.js";
import AIGuardrailService from "./AIGuardrailService.js";
import AIObservabilityService from "./AIObservabilityService.js";
import AIModelRouterService from "./AIModelRouterService.js";
import AIPromptService from "../AIPromptService.js";
import AIAssistantService from "../AIAssistantService.js";
import { getAIConfig } from "../../utils/aiConfig.js";
import { getAIModelConfig } from "../../utils/aiModelConfig.js";
import { publishEvent } from "../../utils/eventBus.js";
import logger from "../../utils/logger.js";

/**
 * EXT-035 "AI Agent Framework & Multi-Agent Orchestration" — the real
 * Supervisor Agent (§6) + Planner (§7, task decomposition down to WHICH
 * agents run, not tool-level sequencing — that's still
 * AIOrchestrationService's job for formal plans) + parallel multi-agent
 * collaboration (§13/§14).
 *
 * Deliberately does NOT reimplement single-agent conversational execution —
 * `coordinate()` decides how many agents are genuinely relevant and, for
 * the common 0-or-1 case, delegates straight to the existing, already
 * fully-tested `AIAssistantService.chat()` unchanged (same guardrails,
 * memory, prompts, observability). Only the real 2+ agent case reaches the
 * new parallel-execution path below — the one capability that could not
 * exist before this document, because concurrently calling
 * AIAssistantService.chat() against the SAME conversation would race
 * (each call reads-then-saves the conversation document independently).
 */
class AISupervisorService {
  static async _buildAgentCatalogText(tenantId, permissions) {
    const candidates = await AIAgentRegistry.listActive({ tenantId, permissions });
    const text = candidates.map((a) => `- ${a.agentId}: ${a.name} — ${a.description} (capabilities: ${a.capabilities.join(", ")})`).join("\n");
    return { candidates, text };
  }

  /**
   * §6/§9 "Supervisor Agent ... Agent Discovery ... Agent selection is
   * dynamic." A real LLM call classifying intent against the REAL, live,
   * lifecycle-and-permission-filtered agent catalog — never a hardcoded
   * keyword map. Hallucinated agentIds are dropped (same discipline
   * AIOrchestrationService.createPlan already applies to hallucinated tool
   * names). On any failure (no eligible agents, unparseable response, no
   * provider reachable) this returns `degraded: true` rather than
   * throwing — §17 "Graceful Degradation" — so `coordinate()` can fall
   * back to the existing single-pass full-catalog chat instead of failing
   * the whole request.
   */
  static async selectAgents({ tenantId, branchId, permissions, message, requestId = null }) {
    const { candidates, text: agentCatalog } = await this._buildAgentCatalogText(tenantId, permissions);
    if (candidates.length === 0) {
      return { agentIds: [], reasoning: "No active agents are available for this tenant/permission set.", degraded: true };
    }

    try {
      const { text: selectionPrompt, versionRef } = await AIPromptService.composeWorkflowPrompt({
        tenantId, branchId, key: "agent_selection", language: "en", variables: { agentCatalog }
      });

      const callStartedAt = Date.now();
      const llmResult = await AIModelRouterService.route({
        tenantId, branchId, category: "planning", correlationId: requestId,
        messages: [{ role: "user", content: message }], tools: [], systemPrompt: selectionPrompt
      });
      if (versionRef) {
        AIPromptService.recordUsage({
          versionId: versionRef.versionId, latencyMs: Date.now() - callStartedAt,
          tokens: (llmResult.usage?.prompt_tokens || llmResult.usage?.input_tokens || 0) + (llmResult.usage?.completion_tokens || llmResult.usage?.output_tokens || 0),
          succeeded: true
        }).catch(() => {});
      }

      const jsonText = (llmResult.content || "{}").replace(/^```json\s*|\s*```$/g, "").trim();
      const parsed = JSON.parse(jsonText);
      const validAgentIds = new Set(candidates.map((a) => a.agentId));
      const agentIds = Array.isArray(parsed.agentIds) ? [...new Set(parsed.agentIds.filter((id) => validAgentIds.has(id)))] : [];

      return {
        agentIds, reasoning: parsed.reasoning || null, degraded: false,
        provider: llmResult.provider, model: llmResult.model, fallbackCount: llmResult.fallbackCount || 0,
        inputTokens: llmResult.usage?.prompt_tokens || llmResult.usage?.input_tokens || 0,
        outputTokens: llmResult.usage?.completion_tokens || llmResult.usage?.output_tokens || 0
      };
    } catch (err) {
      logger.error("AI supervisor agent-selection failed — degrading to single-pass full-catalog chat.", { tenantId, error: err.message });
      return { agentIds: [], reasoning: `Agent selection unavailable (${err.message}).`, degraded: true };
    }
  }

  /**
   * Runs ONE agent's own reasoning turn, scoped to its real least-privilege
   * tool subset, over an INDEPENDENT copy of the conversation history (never
   * the shared array another concurrently-running agent is also reading/
   * writing — §10 "Agents never communicate using free-form text
   * internally": each agent reasons in isolation, the Supervisor is the
   * only one that sees every agent's output). Never touches
   * AIConversationModel itself — `coordinate()` is the single writer, once,
   * after every agent has finished.
   */
  static async _runAgentTurn({ agent, tenantId, branchId, userId, userName, permissions, role, message, baseHistory, context }) {
    const config = getAIConfig();
    const tools = AIAgentRegistry.getToolsForAgent(agent.agentId, permissions).map((t) => ({ name: t.name, description: t.description, parameters: t.parameters }));
    const agentStartedAt = Date.now();

    if (tools.length === 0) {
      return { agentId: agent.agentId, succeeded: false, error: "No accessible tools for this caller's permissions.", answer: null, toolExecutions: [], toolMessages: [], durationMs: Date.now() - agentStartedAt, provider: null, model: null, fallbackCount: 0, inputTokens: 0, outputTokens: 0, ragInfo: null };
    }

    const history = [...baseHistory];
    const toolExecutions = [];
    const toolMessages = [];
    let answer = null;
    let usedProvider = null;
    let usedModel = null;
    let fallbackCount = 0;
    let inputTokens = 0;
    let outputTokens = 0;
    let ragInfo = null;
    let iterations = 0;

    try {
      while (iterations < config.maxToolIterations) {
        iterations += 1;
        const llmResult = await AIModelRouterService.route({
          tenantId, branchId, category: "general_chat", correlationId: context.conversationId,
          messages: history, tools, systemPrompt: `You are the ${agent.name} — ${agent.description} Answer ONLY using your own tools, grounded in their real results. If the user's request needs a capability outside your scope, say so briefly rather than guessing.`
        });
        usedProvider = llmResult.provider;
        usedModel = llmResult.model;
        fallbackCount += llmResult.fallbackCount || 0;
        inputTokens += llmResult.usage?.prompt_tokens || llmResult.usage?.input_tokens || 0;
        outputTokens += llmResult.usage?.completion_tokens || llmResult.usage?.output_tokens || 0;

        if (!llmResult.toolCalls || llmResult.toolCalls.length === 0) {
          answer = llmResult.content || null;
          break;
        }

        history.push({ role: "assistant", content: llmResult.content || "" });

        for (const call of llmResult.toolCalls) {
          const startedAt = Date.now();
          const outcome = await AIToolRegistry.execute(call.name, call.arguments, context);
          const durationMs = Date.now() - startedAt;
          const succeeded = !outcome.error;

          const maskedArguments = AIGuardrailService.maskSensitiveData(call.arguments);
          toolExecutions.push({ toolName: call.name, arguments: maskedArguments, succeeded, durationMs, executedAt: new Date(), rawArguments: call.arguments, rawResult: outcome.result });
          toolMessages.push({ role: "tool", toolName: call.name, toolArguments: maskedArguments, content: JSON.stringify(outcome).slice(0, 4000) });
          publishEvent("AIToolExecuted", { conversationId: context.conversationId, tenantId, agentId: agent.agentId, toolName: call.name, succeeded, durationMs });

          if (call.name === "search_knowledge_base" && succeeded) {
            const citationCount = (outcome.result?.citations || []).length;
            ragInfo = { ragUsed: true, ragHit: citationCount > 0, ragChunkCount: citationCount, ragCitationCount: citationCount };
          }

          history.push({ role: "user", content: `[Tool result for ${call.name}]: ${JSON.stringify(succeeded ? outcome.result : { error: outcome.error }).slice(0, 4000)}` });
        }
      }
    } catch (err) {
      return { agentId: agent.agentId, succeeded: false, error: err.message, answer: null, toolExecutions, toolMessages, durationMs: Date.now() - agentStartedAt, provider: usedProvider, model: usedModel, fallbackCount, inputTokens, outputTokens, ragInfo };
    }

    if (!answer) answer = `The ${agent.name} gathered some information but could not finish reasoning within the allowed steps.`;

    return {
      agentId: agent.agentId, succeeded: true, error: null, answer, toolExecutions, toolMessages,
      durationMs: Date.now() - agentStartedAt, provider: usedProvider, model: usedModel, fallbackCount, inputTokens, outputTokens, ragInfo
    };
  }

  /**
   * §6/§13/§14 "Supervisor Agent ... Parallel Execution ... Merged
   * Recommendation." The real multi-agent entry point. `AIAssistantService`
   * is imported (not the other way around) so this is the one-directional
   * dependency; `AIAssistantService.chat()` itself never calls back into
   * this service.
   */
  static async coordinate(params) {
    const startedAt = Date.now();
    const { tenantId, branchId, userId, userName = "User", permissions = [], role, message, conversationId = null, mode = "Assistant", requestId = null } = params;
    try {
      const config = getAIConfig();
      if (!message || !message.trim()) throw new Error("message is required.");
      if (message.length > config.maxMessageLength) throw new Error(`message exceeds the maximum allowed length of ${config.maxMessageLength} characters.`);

      const flaggedInjection = AIGuardrailService.detectPromptInjection(message);
      const selection = await this.selectAgents({ tenantId, branchId, permissions, message, requestId });

      // §17 "Graceful Degradation" — 0 or 1 relevant agent needs no
      // parallel coordination at all; reuse the existing, fully-tested
      // single-pass path unchanged rather than a second implementation of
      // the same thing.
      if (selection.degraded || selection.agentIds.length <= 1) {
        const chatResult = await AIAssistantService.chat({ tenantId, branchId, userId, userName, permissions, role, message, conversationId, mode, agentId: selection.agentIds[0] || null, requestId });
        return { ...chatResult, supervisorDecision: { agentIds: selection.agentIds, reasoning: selection.reasoning, degraded: selection.degraded, coordinated: false } };
      }

      // ---- 2+ agents: real parallel collaboration ----
      let conversation = conversationId ? await AIConversationModel.findOne({ _id: conversationId, tenantId, userId }) : null;
      const isNewConversation = !conversation;
      if (!conversation) {
        conversation = new AIConversationModel({ tenantId, branchId, userId, mode, messages: [], toolExecutions: [] });
        publishEvent("AIConversationStarted", { conversationId: conversation._id, tenantId, userId, mode });
      }
      conversation.messages.push({ role: "user", content: message });
      if (flaggedInjection) conversation.flaggedPromptInjection = true;

      const storedContext = conversation.context?.toObject ? conversation.context.toObject() : conversation.context;
      const contextExpired = storedContext?.expiresAt && new Date(storedContext.expiresAt).getTime() < Date.now();
      const sessionMemory = (storedContext && storedContext.flight && !contextExpired) ? storedContext : AIContextMemory.empty();

      const context = { tenantId, branchId, userId, userName, permissions, role, conversationId: conversation._id.toString(), executionId: null, promptInjectionFlagged: flaggedInjection };
      const baseHistory = conversation.messages.slice(-config.maxHistoryMessages).filter((m) => m.role !== "tool").map((m) => ({ role: m.role, content: m.content }));

      publishEvent("AISupervisorAgentsSelected", { conversationId: conversation._id, tenantId, agentIds: selection.agentIds, reasoning: selection.reasoning });

      const agentResults = await Promise.allSettled(
        selection.agentIds.map((agentId) => this._runAgentTurn({ agent: AIAgentRegistry.getAgent(agentId), tenantId, branchId, userId, userName, permissions, role, message, baseHistory, context }))
      );
      const results = agentResults.map((r, idx) => (r.status === "fulfilled" ? r.value : { agentId: selection.agentIds[idx], succeeded: false, error: r.reason?.message || "Agent turn failed.", answer: null, toolExecutions: [], toolMessages: [], durationMs: 0, provider: null, model: null, fallbackCount: 0, inputTokens: 0, outputTokens: 0, ragInfo: null }));

      // Merge tool executions/memory sequentially, AFTER every agent has
      // finished — no concurrent mutation of the shared sessionMemory or
      // conversation, only ever this one, single-threaded merge pass.
      let memoryChanged = false;
      let ragUsed = false, ragHit = null, ragChunkCount = 0, ragCitationCount = 0;
      const allToolExecutions = [];
      for (const r of results) {
        conversation.messages.push(...r.toolMessages);
        for (const t of r.toolExecutions) {
          allToolExecutions.push({ toolName: t.toolName, arguments: t.arguments, succeeded: t.succeeded, durationMs: t.durationMs, executedAt: t.executedAt });
          if (t.succeeded) memoryChanged = AIContextMemory.applyToolExecution(sessionMemory, t.toolName, t.rawArguments, t.rawResult) || memoryChanged;
        }
        if (r.ragInfo) { ragUsed = true; ragHit = r.ragInfo.ragHit; ragChunkCount = r.ragInfo.ragChunkCount; ragCitationCount = r.ragInfo.ragCitationCount; }
      }

      const usableResults = results.filter((r) => r.succeeded && r.answer);
      let finalAnswer;
      let mergeProvider = null, mergeModel = null, mergeFallbackCount = 0, mergeInputTokens = 0, mergeOutputTokens = 0;
      if (usableResults.length === 0) {
        finalAnswer = "None of the specialized agents relevant to this request could complete their part right now. Please try again shortly or rephrase your request.";
      } else {
        const resultsSummary = results.map((r) => `Agent "${r.agentId}" (${r.succeeded ? "succeeded" : `failed: ${r.error}`}): ${r.answer || "no answer"}`).join("\n\n");
        const { text: mergePrompt, versionRef: mergeVersionRef } = await AIPromptService.composeWorkflowPrompt({ tenantId, branchId, key: "agent_merge", language: "en", variables: { tenantName: tenantId, branchName: branchId } });
        const mergeCallStartedAt = Date.now();
        const mergeResult = await AIModelRouterService.route({
          tenantId, branchId, category: "reasoning", correlationId: conversation._id.toString(),
          messages: [{ role: "user", content: `User's original request: "${message}"\n\nSpecialized agent results:\n${resultsSummary}` }], tools: [], systemPrompt: mergePrompt
        });
        finalAnswer = mergeResult.content || "I gathered information from multiple specialists but could not finalize a combined answer.";
        mergeProvider = mergeResult.provider; mergeModel = mergeResult.model; mergeFallbackCount = mergeResult.fallbackCount || 0;
        mergeInputTokens = mergeResult.usage?.prompt_tokens || mergeResult.usage?.input_tokens || 0;
        mergeOutputTokens = mergeResult.usage?.completion_tokens || mergeResult.usage?.output_tokens || 0;
        if (mergeVersionRef) {
          AIPromptService.recordUsage({ versionId: mergeVersionRef.versionId, latencyMs: Date.now() - mergeCallStartedAt, tokens: mergeInputTokens + mergeOutputTokens, succeeded: true }).catch(() => {});
        }
      }

      const toolResultsText = conversation.messages.filter((m) => m.role === "tool").map((m) => m.content).join(" ");
      const responseValidation = AIGuardrailService.validateResponse({ finalAnswer, toolResultsText });
      finalAnswer = responseValidation.sanitizedAnswer;

      const successfulTools = allToolExecutions.filter((t) => t.succeeded);
      const failedTools = allToolExecutions.filter((t) => !t.succeeded);
      let confidenceScore = successfulTools.length > 0 ? 60 : 40;
      confidenceScore += Math.min(successfulTools.length * 10, 30);
      confidenceScore -= failedTools.length * 15;
      confidenceScore -= results.filter((r) => !r.succeeded).length * 10;
      confidenceScore = Math.max(0, Math.min(100, confidenceScore));
      const sources = [...new Set(successfulTools.map((t) => t.toolName))];

      const recommendations = [];
      const citations = [];
      for (const r of results) {
        for (const t of r.toolExecutions) {
          if (!t.succeeded) continue;
          if (t.rawResult?.offers) {
            const ranked = AIRankingService.rankOffers(t.rawResult.offers, t.rawArguments || {});
            recommendations.push(...ranked.slice(0, 3).map((o) => ({ source: t.toolName, agentId: r.agentId, ...o })));
          }
          if (t.toolName === "search_knowledge_base" && Array.isArray(t.rawResult?.citations)) citations.push(...t.rawResult.citations);
        }
      }

      conversation.messages.push({ role: "assistant", content: finalAnswer });
      conversation.toolExecutions.push(...allToolExecutions);
      conversation.provider = mergeProvider;
      conversation.lastConfidenceScore = confidenceScore;
      conversation.lastSources = sources;
      if (memoryChanged) { sessionMemory.expiresAt = AIContextMemory.sessionExpiryDate(); conversation.context = sessionMemory; }
      await conversation.save();

      if (memoryChanged) publishEvent("AIContextUpdated", { conversationId: conversation._id, tenantId, summary: AIContextMemory.describeForPrompt(sessionMemory) });
      if (recommendations.length > 0) publishEvent("AIRecommendationGenerated", { conversationId: conversation._id, tenantId, count: recommendations.length, sources });
      publishEvent("AISupervisorCoordinationCompleted", { conversationId: conversation._id, tenantId, agentIds: selection.agentIds, succeededAgents: results.filter((r) => r.succeeded).map((r) => r.agentId) });

      if (mongoose.connection?.readyState === 1) {
        AuditLogModel.create({
          tenantId, userId, action: "AI_SUPERVISOR_COORDINATE", module: "AISupervisor",
          details: { conversationId: conversation._id.toString(), agentIds: selection.agentIds, toolsUsed: sources, flaggedPromptInjection: flaggedInjection }
        }).catch((err) => logger.error("AI supervisor audit log error.", { error: err.message }));
      }

      const totalInputTokens = (selection.inputTokens || 0) + results.reduce((s, r) => s + r.inputTokens, 0) + mergeInputTokens;
      const totalOutputTokens = (selection.outputTokens || 0) + results.reduce((s, r) => s + r.outputTokens, 0) + mergeOutputTokens;
      const costRates = getAIModelConfig().providers[mergeProvider]?.costPerThousandTokens || { input: 0, output: 0 };
      const estimatedCostUsd = Number((((totalInputTokens / 1000) * costRates.input) + ((totalOutputTokens / 1000) * costRates.output)).toFixed(6));

      AIObservabilityService.recordRequestMetric({
        tenantId, branchId, userId, requestId, correlationId: conversation._id.toString(), type: "chat",
        provider: mergeProvider, model: mergeModel, modelFallbackCount: (selection.fallbackCount || 0) + results.reduce((s, r) => s + r.fallbackCount, 0) + mergeFallbackCount,
        durationMs: Date.now() - startedAt,
        inputTokens: totalInputTokens, outputTokens: totalOutputTokens, totalTokens: totalInputTokens + totalOutputTokens,
        estimatedCostUsd, succeeded: true, status: "completed",
        toolCallCount: allToolExecutions.length, toolFailureCount: failedTools.length,
        toolCalls: allToolExecutions.map((t) => ({ toolName: t.toolName, succeeded: t.succeeded, durationMs: t.durationMs, retryCount: 0 })),
        flaggedPromptInjection: flaggedInjection, guardrailBlockedCount: 0,
        confidenceScore, possiblyUngroundedCount: responseValidation.ungroundedClaims.length,
        ragUsed, ragHit, ragChunkCount, ragCitationCount,
        promptFallbackUsed: false,
        agentIds: selection.agentIds, supervisorUsed: true,
        agentBreakdown: results.map((r) => ({ agentId: r.agentId, succeeded: r.succeeded, durationMs: r.durationMs, toolCallCount: r.toolExecutions.length }))
      });

      return {
        conversationId: conversation._id, isNewConversation, answer: finalAnswer, recommendations, citations,
        toolExecutions: allToolExecutions, confidenceScore, possiblyUngroundedClaims: responseValidation.ungroundedClaims,
        sources, provider: mergeProvider, flaggedPromptInjection: flaggedInjection,
        supervisorDecision: { agentIds: selection.agentIds, reasoning: selection.reasoning, degraded: false, coordinated: true },
        agentResults: results.map((r) => ({ agentId: r.agentId, succeeded: r.succeeded, answer: r.answer, error: r.error, durationMs: r.durationMs }))
      };
    } catch (err) {
      AIObservabilityService.recordRequestMetric({
        tenantId, branchId, userId, requestId: requestId || null, correlationId: conversationId || null, type: "chat",
        durationMs: Date.now() - startedAt, succeeded: false, status: "failed",
        errorCategory: AIObservabilityService.classifyError(err.message), errorMessage: err.message,
        flaggedPromptInjection: AIGuardrailService.detectPromptInjection(message || ""), supervisorUsed: true
      });
      logger.error("AISupervisorService.coordinate failed.", { tenantId, userId, error: err.message });
      throw err;
    }
  }
}

export default AISupervisorService;
