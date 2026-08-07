import mongoose from "mongoose";

/**
 * EXT-033 "AI Observability, Monitoring & Evaluation" — the purpose-built
 * analytics fact table this document's metrics categories (§6 Request, §7
 * LLM, §8 Tool, §11 RAG, §13 Quality, §15 Error Categories, §21 Cost) are
 * aggregated from. One row per real, end-user-facing AI interaction — a
 * conversational chat turn (`type: "chat"`) or a formal-plan execution
 * finishing (`type: "plan_execution"`) — written by AIAssistantService.chat
 * and AIOrchestrationService.executePlan respectively.
 *
 * Deliberately separate from the operational records (AIConversationModel,
 * AIToolExecutionModel) that remain the source of truth for actually
 * running the AI — same "Analytics" pattern this codebase already uses
 * elsewhere (CLAUDE.md: "KPIEngine + VisaAnalyticsEngine write summary
 * collections ... dashboards/search read summary/index collections, never
 * live operational Visa/Booking records directly"). `toolCalls` is a
 * denormalized, lightweight copy (not a live reference) specifically so
 * §8 Tool Metrics can be aggregated with one $unwind across BOTH chat-path
 * and plan-path tool calls uniformly, which no single existing collection
 * supports (AIToolExecutionModel only ever covers formal plans; a chat
 * turn's tool calls otherwise only exist buried inside each conversation
 * document).
 */
const AIRequestMetricSchema = new mongoose.Schema(
  {
    tenantId: { type: String, required: true, index: true },
    branchId: { type: String, default: "main", index: true },
    userId: { type: String, default: null, index: true },
    requestId: { type: String, default: null, index: true },
    correlationId: { type: String, default: null, index: true },
    type: { type: String, enum: ["chat", "plan_execution"], required: true, index: true },

    provider: { type: String, default: null },
    model: { type: String, default: null },
    // EXT-034 §10/§20 "Failover Strategy" / "Monitoring — Fallbacks." How
    // many candidate providers the Model Router tried and skipped/failed
    // before the one recorded above actually served this request. 0 means
    // the first-choice candidate succeeded outright.
    modelFallbackCount: { type: Number, default: 0 },
    // EXT-034 §16 "A/B Testing." Set only while an active AIABTestModel
    // exists for this request's category — null otherwise. Real per-variant
    // results (AIModelRouterService.getABTestResults) are aggregated
    // straight from these two fields across this collection.
    abTestId: { type: mongoose.Schema.Types.ObjectId, ref: "AIABTest", default: null, index: true },
    abVariant: { type: String, enum: ["A", "B", null], default: null },
    durationMs: { type: Number, default: 0 },
    inputTokens: { type: Number, default: 0 },
    outputTokens: { type: Number, default: 0 },
    totalTokens: { type: Number, default: 0 },
    estimatedCostUsd: { type: Number, default: 0 },

    succeeded: { type: Boolean, required: true, index: true },
    // §6 "Cancelled Requests" — a more granular outcome than the boolean
    // `succeeded` alone can express (a cancelled/timed-out plan execution
    // is neither a clean success nor an ordinary failure).
    status: { type: String, default: null, index: true },
    // §15 "Error Categories" — null when succeeded=true.
    errorCategory: { type: String, enum: ["llm_error", "provider_error", "timeout", "permission_error", "workflow_error", "tool_error", "policy_violation", "unexpected_error", null], default: null, index: true },
    errorMessage: { type: String, default: null },

    toolCallCount: { type: Number, default: 0 },
    toolFailureCount: { type: Number, default: 0 },
    toolCalls: [
      {
        toolName: { type: String, required: true },
        succeeded: { type: Boolean, default: false },
        durationMs: { type: Number, default: 0 },
        retryCount: { type: Number, default: 0 }
      }
    ],

    flaggedPromptInjection: { type: Boolean, default: false, index: true },
    guardrailBlockedCount: { type: Number, default: 0 },

    // EXT-035 "AI Agent Framework & Multi-Agent Orchestration" §20
    // "Monitoring — Agent Usage, Execution Time ... Success Rate." Real,
    // unified across every path that can involve an agent: a direct chat
    // turn scoped to one agentId, and a Supervisor-coordinated turn
    // spanning several. `agentIds` alone (no breakdown) is what a
    // single-agent chat turn populates; `agentBreakdown` (with real
    // per-agent duration/tool-call/success data) is populated only by
    // AISupervisorService's own parallel execution, which actually has
    // that granularity to report.
    agentIds: [{ type: String }],
    supervisorUsed: { type: Boolean, default: false, index: true },
    agentBreakdown: [
      {
        agentId: { type: String, required: true },
        succeeded: { type: Boolean, default: true },
        durationMs: { type: Number, default: 0 },
        toolCallCount: { type: Number, default: 0 }
      }
    ],
    // §10 "Prompt Metrics — Fallback Usage." True when no tenant-published
    // prompt version was resolved for this request and the relocated
    // default (utils/aiPromptDefaults.js) was used instead — see
    // AIPromptService.composeChatPrompt/composeWorkflowPrompt's own
    // versionRefs/versionRef return value.
    promptFallbackUsed: { type: Boolean, default: true },

    // Chat-turn quality signals (§13) — null for plan_execution rows, which
    // don't produce a conversational confidenceScore.
    confidenceScore: { type: Number, default: null },
    possiblyUngroundedCount: { type: Number, default: 0 },

    // §11 "RAG Metrics" — populated only when this request actually called
    // search_knowledge_base; ragUsed=false for every other request (not
    // every AI interaction touches the knowledge base).
    ragUsed: { type: Boolean, default: false },
    ragHit: { type: Boolean, default: null },
    ragChunkCount: { type: Number, default: 0 },
    ragCitationCount: { type: Number, default: 0 }
  },
  { timestamps: true }
);

AIRequestMetricSchema.index({ tenantId: 1, createdAt: -1 });
AIRequestMetricSchema.index({ tenantId: 1, type: 1, createdAt: -1 });
AIRequestMetricSchema.index({ tenantId: 1, succeeded: 1, createdAt: -1 });

export default mongoose.models.AIRequestMetric || mongoose.model("AIRequestMetric", AIRequestMetricSchema);
