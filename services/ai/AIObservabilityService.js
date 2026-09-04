import mongoose from "mongoose";
import AIRequestMetricModel from "../../models/AIRequestMetricModel.js";
import AIAlertModel from "../../models/AIAlertModel.js";
import AIConversationModel from "../../models/AIConversationModel.js";
import DomainEventModel from "../../models/DomainEventModel.js";
import AIGuardrailService from "./AIGuardrailService.js";
import AIPromptService from "../AIPromptService.js";
import EnterpriseIncidentEngineService from "../EnterpriseIncidentEngineService.js";
import CacheManager from "../../utils/cacheManager.js";
import { getAIObservabilityConfig } from "../../utils/aiObservabilityConfig.js";
import { publishEvent } from "../../utils/eventBus.js";
import logger from "../../utils/logger.js";

/**
 * EXT-033 "AI Observability, Monitoring & Evaluation" — the DevOps/SRE
 * layer over everything built in EXT-026 through EXT-032. Deliberately
 * does NOT import AIAssistantService/AIOrchestrationService (both of which
 * import THIS service to record request metrics) — that would be a
 * circular module dependency. Anything that needs live provider status
 * (health score's availability component, the provider_unavailable alert)
 * takes it as an optional parameter supplied by the caller (the
 * controller, or the alert scheduler), which already has direct access to
 * both services' real `getProviderStatus()` methods.
 */
class AIObservabilityService {
  static _range(from, to, defaultLookbackMs) {
    const range = {};
    range.$gte = from ? new Date(from) : new Date(Date.now() - defaultLookbackMs);
    if (to) range.$lte = new Date(to);
    return range;
  }

  /** §15 "Error Categories" — a bounded, honest classifier, first pattern match wins. */
  static classifyError(message) {
    if (!message) return "unexpected_error";
    const { errorCategoryPatterns } = getAIObservabilityConfig();
    const lower = String(message).toLowerCase();
    for (const [category, pattern] of Object.entries(errorCategoryPatterns)) {
      if (new RegExp(pattern, "i").test(lower)) return category;
    }
    return "unexpected_error";
  }

  /** Written by AIAssistantService.chat() and AIOrchestrationService.executePlan() at the end of every real request, success or failure. */
  static async recordRequestMetric(data) {
    if (mongoose.connection?.readyState !== 1) return null;
    try {
      return await AIRequestMetricModel.create(data);
    } catch (err) {
      logger.error("AI request metric recording failed.", { error: err.message });
      return null;
    }
  }

  /** §6 "Request Metrics." */
  static async getRequestMetrics({ tenantId, from, to }) {
    const config = getAIObservabilityConfig();
    const range = this._range(from, to, config.defaultLookbackMs);
    if (mongoose.connection?.readyState !== 1) {
      return { tenantId, totalRequests: 0, successfulRequests: 0, failedRequests: 0, successRatePct: null, averageResponseTimeMs: null, peakRequestsPerHour: 0, byType: {}, byStatus: {} };
    }

    const [result] = await AIRequestMetricModel.aggregate([
      { $match: { tenantId, createdAt: range } },
      { $facet: {
        totals: [{ $group: { _id: null, total: { $sum: 1 }, succeeded: { $sum: { $cond: ["$succeeded", 1, 0] } }, avgDuration: { $avg: "$durationMs" } } }],
        byType: [{ $group: { _id: "$type", count: { $sum: 1 } } }],
        byStatus: [{ $group: { _id: "$status", count: { $sum: 1 } } }],
        byHour: [{ $group: { _id: { $dateToString: { format: "%Y-%m-%dT%H", date: "$createdAt" } }, count: { $sum: 1 } } }]
      } }
    ]);

    const totals = result?.totals?.[0] || { total: 0, succeeded: 0, avgDuration: null };
    const byType = {}; for (const r of result?.byType || []) byType[r._id || "unknown"] = r.count;
    const byStatus = {}; for (const r of result?.byStatus || []) byStatus[r._id || "unknown"] = r.count;
    const peakRequestsPerHour = (result?.byHour || []).reduce((max, r) => Math.max(max, r.count), 0);

    return {
      tenantId,
      totalRequests: totals.total,
      successfulRequests: totals.succeeded,
      failedRequests: totals.total - totals.succeeded,
      successRatePct: totals.total > 0 ? Number(((totals.succeeded / totals.total) * 100).toFixed(1)) : null,
      averageResponseTimeMs: totals.avgDuration != null ? Math.round(totals.avgDuration) : null,
      peakRequestsPerHour,
      byType,
      byStatus
    };
  }

  /** §7 "LLM Metrics." */
  static async getLLMMetrics({ tenantId, from, to }) {
    const config = getAIObservabilityConfig();
    const range = this._range(from, to, config.defaultLookbackMs);
    if (mongoose.connection?.readyState !== 1) return { tenantId, byProvider: [] };

    const rows = await AIRequestMetricModel.aggregate([
      { $match: { tenantId, createdAt: range, provider: { $ne: null } } },
      { $group: {
        _id: { provider: "$provider", model: "$model" },
        requests: { $sum: 1 },
        succeeded: { $sum: { $cond: ["$succeeded", 1, 0] } },
        avgInputTokens: { $avg: "$inputTokens" },
        avgOutputTokens: { $avg: "$outputTokens" },
        totalTokens: { $sum: "$totalTokens" },
        avgDurationMs: { $avg: "$durationMs" },
        providerErrors: { $sum: { $cond: [{ $eq: ["$errorCategory", "provider_error"] }, 1, 0] } }
      } }
    ]);

    return {
      tenantId,
      byProvider: rows.map((r) => ({
        provider: r._id.provider, model: r._id.model, requests: r.requests,
        successRatePct: r.requests > 0 ? Number(((r.succeeded / r.requests) * 100).toFixed(1)) : null,
        averageInputTokens: Math.round(r.avgInputTokens || 0),
        averageOutputTokens: Math.round(r.avgOutputTokens || 0),
        totalTokens: r.totalTokens,
        averageDurationMs: r.avgDurationMs != null ? Math.round(r.avgDurationMs) : null,
        providerErrors: r.providerErrors
      }))
    };
  }

  /** §8 "Tool Metrics" — a single aggregation across BOTH the chat path and the plan-execution path, via the denormalized toolCalls[] every AIRequestMetricModel row carries. */
  static async getToolMetrics({ tenantId, from, to }) {
    const config = getAIObservabilityConfig();
    const range = this._range(from, to, config.defaultLookbackMs);
    if (mongoose.connection?.readyState !== 1) return { tenantId, tools: [] };

    const rows = await AIRequestMetricModel.aggregate([
      { $match: { tenantId, createdAt: range } },
      { $unwind: "$toolCalls" },
      { $group: {
        _id: "$toolCalls.toolName",
        totalCalls: { $sum: 1 },
        succeeded: { $sum: { $cond: ["$toolCalls.succeeded", 1, 0] } },
        totalRetries: { $sum: "$toolCalls.retryCount" },
        avgDurationMs: { $avg: "$toolCalls.durationMs" }
      } },
      { $sort: { totalCalls: -1 } }
    ]);

    return {
      tenantId,
      tools: rows.map((r) => ({
        toolName: r._id,
        totalCalls: r.totalCalls,
        succeeded: r.succeeded,
        failed: r.totalCalls - r.succeeded,
        successRatePct: r.totalCalls > 0 ? Number(((r.succeeded / r.totalCalls) * 100).toFixed(1)) : null,
        totalRetries: r.totalRetries,
        averageDurationMs: r.avgDurationMs != null ? Math.round(r.avgDurationMs) : null
      }))
    };
  }

  /**
   * EXT-035 §20 "Monitoring — Agent Usage, Execution Time, Success Rate."
   * Real, unified across both agent-involving paths: a direct chat turn
   * scoped to one agentId (only `agentIds` populated) and a
   * Supervisor-coordinated turn (the richer `agentBreakdown`, preferred
   * whenever present since it has genuine per-agent duration/tool-call
   * data instead of the whole request's aggregate figures).
   */
  static async getAgentMetrics({ tenantId, from, to }) {
    const config = getAIObservabilityConfig();
    const range = this._range(from, to, config.defaultLookbackMs);
    if (mongoose.connection?.readyState !== 1) return { tenantId, agents: [] };

    const rows = await AIRequestMetricModel.aggregate([
      { $match: { tenantId, createdAt: range, "agentIds.0": { $exists: true } } },
      { $project: {
        entries: {
          $cond: [
            { $gt: [{ $size: { $ifNull: ["$agentBreakdown", []] } }, 0] },
            "$agentBreakdown",
            { $map: { input: "$agentIds", as: "id", in: { agentId: "$$id", succeeded: "$succeeded", durationMs: "$durationMs", toolCallCount: "$toolCallCount" } } }
          ]
        }
      } },
      { $unwind: "$entries" },
      { $group: { _id: "$entries.agentId", totalUses: { $sum: 1 }, succeeded: { $sum: { $cond: ["$entries.succeeded", 1, 0] } }, avgDurationMs: { $avg: "$entries.durationMs" }, totalToolCalls: { $sum: "$entries.toolCallCount" } } },
      { $sort: { totalUses: -1 } }
    ]);

    return {
      tenantId,
      agents: rows.map((r) => ({
        agentId: r._id, totalUses: r.totalUses, succeeded: r.succeeded, failed: r.totalUses - r.succeeded,
        successRatePct: r.totalUses > 0 ? Number(((r.succeeded / r.totalUses) * 100).toFixed(1)) : null,
        averageDurationMs: r.avgDurationMs != null ? Math.round(r.avgDurationMs) : null,
        totalToolCalls: r.totalToolCalls
      }))
    };
  }

  /**
   * §11 "RAG Metrics." Retrieval TIME is deliberately not duplicated here —
   * `search_knowledge_base`'s own call is already one of the rows in
   * getToolMetrics()'s toolCalls breakdown, which is the real source for
   * that. "Knowledge Freshness" / "Chunk Quality" as standalone metrics are
   * NOT tracked — there is no rating signal beyond the ranking `confidence`
   * score already returned per citation (AIKnowledgeService.buildContextBlock);
   * inventing a separate freshness/quality number here would be redundant
   * with, not additive to, that real score.
   */
  static async getRAGMetrics({ tenantId, from, to }) {
    const config = getAIObservabilityConfig();
    const range = this._range(from, to, config.defaultLookbackMs);
    if (mongoose.connection?.readyState !== 1) return { tenantId, retrievals: 0, hitRatePct: null, missRatePct: null, averageRetrievedChunks: null, averageCitationsPerRetrieval: null, averageChunksScanned: null };

    const [row] = await AIRequestMetricModel.aggregate([
      { $match: { tenantId, createdAt: range, ragUsed: true } },
      { $group: { _id: null, total: { $sum: 1 }, hits: { $sum: { $cond: ["$ragHit", 1, 0] } }, avgChunks: { $avg: "$ragChunkCount" }, avgCitations: { $avg: "$ragCitationCount" }, avgScanned: { $avg: "$ragChunksScanned" } } }
    ]);
    const total = row?.total || 0;

    return {
      tenantId,
      retrievals: total,
      hitRatePct: total > 0 ? Number(((row.hits / total) * 100).toFixed(1)) : null,
      missRatePct: total > 0 ? Number((((total - row.hits) / total) * 100).toFixed(1)) : null,
      averageRetrievedChunks: row?.avgChunks != null ? Number(row.avgChunks.toFixed(1)) : null,
      averageCitationsPerRetrieval: row?.avgCitations != null ? Number(row.avgCitations.toFixed(1)) : null,
      // Gap 1.4 — the real scan-cost signal (distinct from averageRetrievedChunks,
      // which is the RETURNED count) a future vector-DB-migration decision
      // should be based on, not a guess.
      averageChunksScanned: row?.avgScanned != null ? Number(row.avgScanned.toFixed(1)) : null
    };
  }

  /**
   * §12 "Memory Metrics." "Context Growth" (exact byte size across every
   * conversation) is deliberately not computed here — MongoDB's aggregation
   * pipeline has no built-in way to stringify a subdocument for a size
   * measurement, and pulling every conversation document into application
   * memory just to JSON.stringify it would be an expensive, unbounded scan
   * on the hot path of a monitoring endpoint. Live/expired memory PRESENCE
   * (a real, cheap aggregation) and the shared CacheManager's real hit-rate
   * counters are what's reported instead.
   */
  static async getMemoryMetrics({ tenantId }) {
    const cache = CacheManager.getStats();
    if (mongoose.connection?.readyState !== 1) {
      return { tenantId, totalActiveConversations: 0, conversationsWithLiveMemory: 0, conversationsWithExpiredMemory: 0, cache };
    }
    const now = new Date();
    const [row] = await AIConversationModel.aggregate([
      { $match: { tenantId, status: "active" } },
      { $project: {
        hasMemory: { $cond: [{ $ifNull: ["$context.flight", false] }, 1, 0] },
        isExpired: { $cond: [{ $and: [{ $ifNull: ["$context.expiresAt", false] }, { $lt: ["$context.expiresAt", now] }] }, 1, 0] }
      } },
      { $group: { _id: null, total: { $sum: 1 }, withMemory: { $sum: "$hasMemory" }, expired: { $sum: "$isExpired" } } }
    ]);
    return {
      tenantId,
      totalActiveConversations: row?.total || 0,
      conversationsWithLiveMemory: row?.withMemory || 0,
      conversationsWithExpiredMemory: row?.expired || 0,
      cache
    };
  }

  /**
   * §13 "AI Quality Metrics." "Hallucination Rate" is a disclosed PROXY —
   * the share of answers carrying EXT-032 validateResponse's own advisory
   * possiblyUngroundedClaims flag — never a claim of measuring true
   * hallucination, which needs human/ground-truth review this codebase has
   * no UI for. "Citation Accuracy" / "Recommendation Accuracy" / "Business
   * Rule Compliance" are NOT computed here for the same reason: no feedback
   * or rating capability exists anywhere in this codebase to derive them
   * from real data, and fabricating a number would be worse than omitting
   * it. "Workflow Success" is already real and available via
   * AIOrchestrationService.getWorkflowMetrics — not duplicated here.
   */
  static async getQualityMetrics({ tenantId, from, to }) {
    const config = getAIObservabilityConfig();
    const range = this._range(from, to, config.defaultLookbackMs);
    if (mongoose.connection?.readyState !== 1) return { tenantId, sampleSize: 0, averageConfidenceScore: null, ungroundedRatePct: null };

    const [row] = await AIRequestMetricModel.aggregate([
      { $match: { tenantId, createdAt: range, type: "chat" } },
      { $group: { _id: null, total: { $sum: 1 }, avgConfidence: { $avg: "$confidenceScore" }, ungrounded: { $sum: { $cond: [{ $gt: ["$possiblyUngroundedCount", 0] }, 1, 0] } } } }
    ]);
    const total = row?.total || 0;

    return {
      tenantId,
      sampleSize: total,
      averageConfidenceScore: row?.avgConfidence != null ? Number(row.avgConfidence.toFixed(1)) : null,
      ungroundedRatePct: total > 0 ? Number(((row.ungrounded / total) * 100).toFixed(1)) : null
    };
  }

  /** §21 "Cost Monitoring." Sourced entirely from AIRequestMetricModel — every chat turn and plan execution's real, already-computed estimatedCostUsd lands there. */
  static async getCostMetrics({ tenantId, from, to, groupBy = "day" }) {
    const config = getAIObservabilityConfig();
    const range = this._range(from, to, config.defaultLookbackMs);
    if (mongoose.connection?.readyState !== 1) return { tenantId, totalCostUsd: 0, groupBy, byPeriod: [] };

    const dateFormat = groupBy === "month" ? "%Y-%m" : "%Y-%m-%d";
    const rows = await AIRequestMetricModel.aggregate([
      { $match: { tenantId, createdAt: range } },
      { $group: { _id: { $dateToString: { format: dateFormat, date: "$createdAt" } }, costUsd: { $sum: "$estimatedCostUsd" }, totalTokens: { $sum: "$totalTokens" }, requests: { $sum: 1 } } },
      { $sort: { _id: 1 } }
    ]);

    const totalCostUsd = Number(rows.reduce((sum, r) => sum + r.costUsd, 0).toFixed(6));
    return {
      tenantId, totalCostUsd, groupBy,
      byPeriod: rows.map((r) => ({ period: r._id, costUsd: Number(r.costUsd.toFixed(6)), totalTokens: r.totalTokens, requests: r.requests }))
    };
  }

  /** §10 "Prompt Metrics", tenant-wide. Per-version detail delegates to AIPromptService.getPromptMetrics (real, already built in EXT-031) — not duplicated. "Fallback Usage" is new here, from AIRequestMetricModel.promptFallbackUsed. */
  static async getPromptDashboard({ tenantId }) {
    const promptList = await AIPromptService.listPrompts({ tenantId, pageSize: 50 });
    const items = [];
    for (const prompt of promptList.items) {
      const versions = await AIPromptService.getPromptMetrics({ tenantId, promptId: prompt._id });
      items.push({ promptId: prompt._id, promptType: prompt.promptType, key: prompt.key, language: prompt.language, name: prompt.name, versions });
    }

    let fallbackUsageRatePct = null;
    if (mongoose.connection?.readyState === 1) {
      const config = getAIObservabilityConfig();
      const range = this._range(null, null, config.defaultLookbackMs);
      const [row] = await AIRequestMetricModel.aggregate([
        { $match: { tenantId, createdAt: range } },
        { $group: { _id: null, total: { $sum: 1 }, fallback: { $sum: { $cond: ["$promptFallbackUsed", 1, 0] } } } }
      ]);
      if (row?.total) fallbackUsageRatePct = Number(((row.fallback / row.total) * 100).toFixed(1));
    }

    return { tenantId, prompts: items, fallbackUsageRatePct };
  }

  /** §23 "Security Monitoring." Delegates the guardrail-decision counters to AIGuardrailService (EXT-032, real and already built); adds the two categories that weren't tracked anywhere — real events counted from the durable DomainEventModel outbox. */
  static async getSecurityMetrics({ tenantId, from, to }) {
    const guardrailMetrics = await AIGuardrailService.getGuardrailMetrics({ tenantId });
    if (mongoose.connection?.readyState !== 1) {
      return { ...guardrailMetrics, unauthorizedAccessAttempts: 0, approvalViolations: 0 };
    }
    const config = getAIObservabilityConfig();
    const range = this._range(from, to, config.defaultLookbackMs);
    const [unauthorizedAccessAttempts, approvalViolations] = await Promise.all([
      DomainEventModel.countDocuments({ tenantId, eventType: "AIUnauthorizedToolAccess", occurredAt: range }),
      DomainEventModel.countDocuments({ tenantId, eventType: "AIApprovalRoleViolation", occurredAt: range })
    ]);
    return { ...guardrailMetrics, unauthorizedAccessAttempts, approvalViolations };
  }

  /**
   * §22 "AI Health Score." A real, transparent, weighted composite — same
   * honesty precedent as every other computed score in this AI module
   * (confidenceScore, riskScore). `providerStatus` is optional, supplied by
   * the caller (see this file's own docblock for why it isn't fetched
   * here); without it, availability falls back to the request success
   * rate as the best available proxy.
   */
  static async getHealthScore({ tenantId, providerStatus = null }) {
    const config = getAIObservabilityConfig();
    const [requestMetrics, toolMetrics, qualityMetrics, guardrailMetrics] = await Promise.all([
      this.getRequestMetrics({ tenantId }),
      this.getToolMetrics({ tenantId }),
      this.getQualityMetrics({ tenantId }),
      AIGuardrailService.getGuardrailMetrics({ tenantId })
    ]);

    let availabilityScore;
    if (providerStatus && Object.keys(providerStatus).length > 0) {
      const statuses = Object.values(providerStatus);
      const healthyCount = statuses.filter((s) => s.status === "UP" && s.circuitBreaker?.status !== "open").length;
      availabilityScore = (healthyCount / statuses.length) * 100;
    } else {
      availabilityScore = requestMetrics.successRatePct ?? 100;
    }

    const latencyScore = requestMetrics.averageResponseTimeMs == null
      ? 100
      : Math.max(0, Math.min(100, 100 - ((requestMetrics.averageResponseTimeMs - config.latencyGoodMs) / (config.latencyPoorMs - config.latencyGoodMs)) * 100));

    const failuresScore = requestMetrics.successRatePct ?? 100;

    const guardrailTotal = guardrailMetrics.totalDecisions || 0;
    const injectionRatePct = guardrailTotal > 0 ? (guardrailMetrics.injectionAttempts / guardrailTotal) * 100 : 0;
    // A high BLOCK rate is the guardrail doing its job, not a health
    // problem — only the genuine attack signal (injection attempts) drags
    // the safety sub-score down.
    const safetyScore = Math.max(0, 100 - injectionRatePct * 2);

    const qualityScore = qualityMetrics.ungroundedRatePct != null ? Math.max(0, 100 - qualityMetrics.ungroundedRatePct * 2) : 100;

    const toolTotals = toolMetrics.tools.reduce((acc, t) => ({ calls: acc.calls + t.totalCalls, succeeded: acc.succeeded + t.succeeded }), { calls: 0, succeeded: 0 });
    const toolSuccessScore = toolTotals.calls > 0 ? (toolTotals.succeeded / toolTotals.calls) * 100 : 100;

    const weights = config.healthScoreWeights;
    const overall = (availabilityScore * weights.availability) + (latencyScore * weights.latency) + (failuresScore * weights.failures)
      + (safetyScore * weights.safety) + (qualityScore * weights.quality) + (toolSuccessScore * weights.toolSuccess);

    return {
      tenantId,
      overallScore: Math.round(Math.max(0, Math.min(100, overall))),
      breakdown: {
        availability: Math.round(availabilityScore), latency: Math.round(latencyScore), failures: Math.round(failuresScore),
        safety: Math.round(safetyScore), quality: Math.round(qualityScore), toolSuccess: Math.round(toolSuccessScore)
      },
      sampleSize: requestMetrics.totalRequests
    };
  }

  /** §18 "Executive Dashboard" — a rollup of the real sub-metrics above. */
  static async getExecutiveDashboard({ tenantId, providerStatus = null }) {
    const [health, requestMetrics, costMetrics, qualityMetrics, security] = await Promise.all([
      this.getHealthScore({ tenantId, providerStatus }),
      this.getRequestMetrics({ tenantId }),
      this.getCostMetrics({ tenantId }),
      this.getQualityMetrics({ tenantId }),
      this.getSecurityMetrics({ tenantId })
    ]);
    return { tenantId, health, requestMetrics, costMetrics, qualityMetrics, security };
  }

  // ---- Alerting (§19) ----

  static async _upsertAlert({ tenantId, alertType, severity, message, metricValue, thresholdValue }) {
    const existing = await AIAlertModel.findOne({ tenantId, alertType, status: "active" });
    if (existing) return null; // already active — don't re-fire every sweep

    const alert = await AIAlertModel.create({ tenantId, alertType, severity, message, metricValue, thresholdValue, status: "active", triggeredAt: new Date() });
    publishEvent("AIAlertTriggered", { tenantId, alertId: alert._id, alertType, severity, message, metricValue, thresholdValue });
    publishEvent("NotificationRequested", { tenantId, event: "AIAlertTriggered", priority: severity === "critical" ? "high" : "normal", alertId: alert._id, alertType, message });

    if (severity === "critical") {
      EnterpriseIncidentEngineService.createIncident({
        sourceModule: "AIObservability", category: "Technical Issue", type: `AI Alert: ${alertType}`, severity: "High",
        title: message, description: `Real-time metric breached its configured threshold (value: ${metricValue}, threshold: ${thresholdValue}).`
      }, tenantId, "system").catch((err) => logger.error("AI alert incident creation failed.", { error: err.message }));
    }
    return alert;
  }

  static async _resolveAlertIfActive({ tenantId, alertType }) {
    const existing = await AIAlertModel.findOne({ tenantId, alertType, status: "active" });
    if (!existing) return null;
    existing.status = "resolved";
    existing.resolvedAt = new Date();
    await existing.save();
    publishEvent("AIAlertResolved", { tenantId, alertId: existing._id, alertType });
    return existing;
  }

  /**
   * Real threshold evaluation over a recent rolling window — opens/keeps an
   * AIAlertModel row active while a threshold stays breached, resolves it
   * the moment the same check passes clean. `providerStatus` is optional
   * (supplied by the scheduler, which has direct access to both AI
   * services' real getProviderStatus() — see this file's own docblock).
   */
  static async evaluateAlerts({ tenantId, providerStatus = null }) {
    if (mongoose.connection?.readyState !== 1) return { evaluated: false, triggered: [], resolved: [] };
    const config = getAIObservabilityConfig();
    const from = new Date(Date.now() - config.alertEvaluationWindowMs);
    const thresholds = config.alertThresholds;

    const [requestMetrics, toolMetrics, qualityMetrics, costMetrics, guardrailMetrics] = await Promise.all([
      this.getRequestMetrics({ tenantId, from }),
      this.getToolMetrics({ tenantId, from }),
      this.getQualityMetrics({ tenantId, from }),
      this.getCostMetrics({ tenantId, from, groupBy: "day" }),
      AIGuardrailService.getGuardrailMetrics({ tenantId })
    ]);

    const triggered = [];
    const resolved = [];
    const check = async (condition, alertType, severity, message, metricValue, thresholdValue) => {
      if (condition) {
        const a = await this._upsertAlert({ tenantId, alertType, severity, message, metricValue, thresholdValue });
        if (a) triggered.push(a);
      } else {
        const r = await this._resolveAlertIfActive({ tenantId, alertType });
        if (r) resolved.push(r);
      }
    };

    // §14 doesn't apply here; a window too thin to judge a rate-based
    // threshold (e.g. 1 failure out of 1 request) is simply not evaluated.
    if (requestMetrics.totalRequests >= config.alertMinSampleSize) {
      const failureRatePct = 100 - (requestMetrics.successRatePct ?? 100);
      await check(failureRatePct >= thresholds.failureRatePct, "high_failure_rate", "critical",
        `AI request failure rate is ${failureRatePct.toFixed(1)}% over the last window (threshold ${thresholds.failureRatePct}%).`, Number(failureRatePct.toFixed(1)), thresholds.failureRatePct);

      await check(requestMetrics.averageResponseTimeMs != null && requestMetrics.averageResponseTimeMs >= thresholds.highLatencyMs, "high_latency", "warning",
        `Average AI response time is ${requestMetrics.averageResponseTimeMs}ms over the last window (threshold ${thresholds.highLatencyMs}ms).`, requestMetrics.averageResponseTimeMs, thresholds.highLatencyMs);

      await check(qualityMetrics.ungroundedRatePct != null && qualityMetrics.ungroundedRatePct >= thresholds.hallucinationRatePct, "high_hallucination_rate", "warning",
        `${qualityMetrics.ungroundedRatePct}% of recent answers carry a possibly-ungrounded claim flag (threshold ${thresholds.hallucinationRatePct}%).`, qualityMetrics.ungroundedRatePct, thresholds.hallucinationRatePct);

      const toolTotals = toolMetrics.tools.reduce((acc, t) => ({ calls: acc.calls + t.totalCalls, failed: acc.failed + t.failed }), { calls: 0, failed: 0 });
      const toolFailureRatePct = toolTotals.calls > 0 ? (toolTotals.failed / toolTotals.calls) * 100 : 0;
      await check(toolTotals.calls > 0 && toolFailureRatePct >= thresholds.toolFailureRatePct, "high_tool_failure_rate", "warning",
        `AI tool call failure rate is ${toolFailureRatePct.toFixed(1)}% over the last window (threshold ${thresholds.toolFailureRatePct}%).`, Number(toolFailureRatePct.toFixed(1)), thresholds.toolFailureRatePct);

      const guardrailTotal = guardrailMetrics.totalDecisions || 0;
      const blockRatePct = guardrailTotal > 0 ? (guardrailMetrics.blockedRequests / guardrailTotal) * 100 : 0;
      await check(guardrailTotal > 0 && blockRatePct >= thresholds.guardrailBlockRatePct, "high_guardrail_block_rate", "warning",
        `${blockRatePct.toFixed(1)}% of guardrail decisions were blocks over the last window (threshold ${thresholds.guardrailBlockRatePct}%).`, Number(blockRatePct.toFixed(1)), thresholds.guardrailBlockRatePct);
    }

    await check(costMetrics.totalCostUsd >= thresholds.dailyCostUsd, "cost_spike", "warning",
      `AI cost over the last window is $${costMetrics.totalCostUsd.toFixed(2)} (threshold $${thresholds.dailyCostUsd}).`, costMetrics.totalCostUsd, thresholds.dailyCostUsd);

    if (thresholds.providerUnavailable && providerStatus && Object.keys(providerStatus).length > 0) {
      const allDown = Object.values(providerStatus).every((s) => s.status !== "UP" || s.circuitBreaker?.status === "open");
      await check(allDown, "provider_unavailable", "critical", "No configured AI provider is currently reachable.", null, null);
    }

    return { evaluated: true, triggered, resolved };
  }

  static async listAlerts({ tenantId, status, page = 1, pageSize = 20 }) {
    const safePage = Math.max(parseInt(page, 10) || 1, 1);
    const safePageSize = Math.min(Math.max(parseInt(pageSize, 10) || 20, 1), 100);
    const filter = { tenantId };
    if (status) filter.status = status;
    const [items, totalItems] = await Promise.all([
      AIAlertModel.find(filter).sort({ createdAt: -1 }).skip((safePage - 1) * safePageSize).limit(safePageSize).lean(),
      AIAlertModel.countDocuments(filter)
    ]);
    return { items, pagination: { page: safePage, pageSize: safePageSize, totalItems, totalPages: Math.ceil(totalItems / safePageSize) || 1 } };
  }
}

export default AIObservabilityService;
