import mongoose from "mongoose";
import AIRoutingPolicyModel from "../../models/AIRoutingPolicyModel.js";
import AIABTestModel from "../../models/AIABTestModel.js";
import AIShadowTestResultModel from "../../models/AIShadowTestResultModel.js";
import AIRequestMetricModel from "../../models/AIRequestMetricModel.js";
import OpenAIAdapter from "./OpenAIAdapter.js";
import AnthropicAdapter from "./AnthropicAdapter.js";
import AzureOpenAIAdapter from "./AzureOpenAIAdapter.js";
import OpenAICompatibleAdapter from "./OpenAICompatibleAdapter.js";
import { getAIConfig } from "../../utils/aiConfig.js";
import { getAIModelConfig } from "../../utils/aiModelConfig.js";
import { publishEvent } from "../../utils/eventBus.js";
import logger from "../../utils/logger.js";

/** Moved here, unchanged, from what used to be two independent copies (AIAssistantService and AIOrchestrationService each kept their own — meaning a failure seen by one never protected the other from hammering the same physical provider). One shared breaker per provider name is the real fix. */
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

/**
 * EXT-034 "AI Model Management & Multi-LLM Routing" — the real Model Router
 * ("Application -> AI Gateway -> Model Router -> Provider Adapter -> LLM
 * Provider"). Both `AIAssistantService` and `AIOrchestrationService` route
 * every LLM call through this single service instead of each maintaining
 * its own adapter map, circuit breaker, and failover loop — the exact
 * duplication this document exists to remove. Neither of those two
 * services is imported here (they both import THIS service), so there is
 * no circular dependency.
 */
class AIModelRouterService {
  static circuitBreaker = new CircuitBreaker();
  static _adapterCache = {};

  static _getAdapter(providerName) {
    if (this._adapterCache[providerName]) return this._adapterCache[providerName];
    const config = getAIModelConfig();
    const providerConfig = config.providers[providerName];
    if (!providerConfig) return null;

    let adapter;
    if (providerName === "OpenAI") adapter = new OpenAIAdapter();
    else if (providerName === "Anthropic") adapter = new AnthropicAdapter();
    else if (providerName === "AzureOpenAI") adapter = new AzureOpenAIAdapter();
    else adapter = new OpenAICompatibleAdapter({ providerName, apiKey: providerConfig.apiKey, baseUrl: providerConfig.baseUrl, model: providerConfig.model });

    this._adapterCache[providerName] = adapter;
    return adapter;
  }

  static async _callWithRetry(adapter, params) {
    const { maxRetries } = getAIConfig();
    let lastError;
    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      try { return await adapter.chatWithTools(params); } catch (err) { lastError = err; }
    }
    throw lastError;
  }

  /**
   * §8 "Routing Strategy — Capability Detection -> Policy Validation ->
   * Provider Ranking -> Health Check -> Cost Evaluation -> Model Selection
   * -> Execute." Returns the same shape `_callLLM` used to (`{provider,
   * content, toolCalls, finishReason, usage, ...}`), plus real router
   * metadata (`model`, `fallbackCount`, `abTestId`, `abVariant`) callers can
   * fold straight into their existing AIRequestMetricModel row.
   */
  static async route({ tenantId, branchId = "main", category = "general_chat", correlationId = null, messages, tools = [], systemPrompt }) {
    const config = getAIModelConfig();
    const resolvedCategory = config.categories.includes(category) ? category : "general_chat";
    const requiresToolCalling = tools.length > 0;

    const isEligible = (providerName) => {
      const p = config.providers[providerName];
      return Boolean(p?.enabled) && (!requiresToolCalling || p.capabilities.toolCalling) && p.categories.includes(resolvedCategory);
    };

    // §9 "Routing Rules" — a tenant policy re-orders/restricts among real
    // candidates; it can never make an ineligible provider eligible.
    let policy = null;
    if (mongoose.connection?.readyState === 1) {
      policy = await AIRoutingPolicyModel.findOne({ tenantId, branchId, category: resolvedCategory, isActive: true }).lean();
    }

    let providerOrder = (policy?.preferredProviders?.length > 0) ? policy.preferredProviders : config.defaultRoutingOrder;
    let eligibleProviders = providerOrder.filter(isEligible);
    if (eligibleProviders.length === 0) eligibleProviders = config.defaultRoutingOrder.filter(isEligible);

    // §14 "Cheapest suitable model selected when allowed."
    if (policy?.costOptimized) {
      eligibleProviders = [...eligibleProviders].sort((a, b) => {
        const costA = config.providers[a].costPerThousandTokens.input + config.providers[a].costPerThousandTokens.output;
        const costB = config.providers[b].costPerThousandTokens.input + config.providers[b].costPerThousandTokens.output;
        return costA - costB;
      });
    }

    let candidates = eligibleProviders.map((name) => ({
      provider: name,
      model: policy?.preferredModelOverride?.provider === name ? policy.preferredModelOverride.model : null
    }));

    // §16 "A/B Testing." Only one active test per tenant+category can ever
    // exist (enforced in startABTest); the assigned variant is pinned to
    // the FRONT of the candidate list — still a real fallback chain behind
    // it, an A/B test is never allowed to remove failover safety.
    let abTestId = null;
    let abVariant = null;
    if (mongoose.connection?.readyState === 1) {
      const activeTest = await AIABTestModel.findOne({ tenantId, branchId, category: resolvedCategory, status: "running" }).lean();
      if (activeTest) {
        const assignedVariant = Math.random() * 100 < activeTest.trafficSplitPct ? "A" : "B";
        const chosen = assignedVariant === "A" ? activeTest.variantA : activeTest.variantB;
        if (isEligible(chosen.provider)) {
          abTestId = activeTest._id;
          abVariant = assignedVariant;
          candidates = [{ provider: chosen.provider, model: chosen.model || null }, ...candidates.filter((c) => c.provider !== chosen.provider)];
        }
      }
    }

    if (candidates.length === 0) {
      const error = new Error(`AI service is not available: no provider is configured and eligible for category '${resolvedCategory}'${requiresToolCalling ? " with tool-calling support" : ""}.`);
      error.code = "AI_UNAVAILABLE";
      throw error;
    }

    let fallbackCount = 0;
    const attemptErrors = [];
    for (const { provider: providerName, model: modelOverride } of candidates) {
      const adapter = this._getAdapter(providerName);
      if (!adapter?.isConfigured() || !this.circuitBreaker.canAttempt(providerName)) { fallbackCount += 1; continue; }
      try {
        const result = await this._callWithRetry(adapter, { messages, tools, systemPrompt, model: modelOverride || undefined });
        this.circuitBreaker.recordSuccess(providerName);
        const resolvedModel = modelOverride || config.providers[providerName].model;

        // §17 "Shadow Testing" — fire-and-forget, never on the response's critical path.
        if (policy?.shadowProvider && policy.shadowProvider !== providerName) {
          this._fireShadowTest({
            tenantId, branchId, category: resolvedCategory, correlationId,
            primaryProvider: providerName, primaryModel: resolvedModel, primaryResult: result,
            params: { messages, tools, systemPrompt }, shadowProvider: policy.shadowProvider, shadowModel: policy.shadowModel
          }).catch(() => {});
        }

        return { provider: providerName, model: resolvedModel, fallbackCount, abTestId, abVariant, ...result };
      } catch (err) {
        this.circuitBreaker.recordFailure(providerName);
        attemptErrors.push(`${providerName}: ${err.message}`);
        fallbackCount += 1;
      }
    }

    // Same honest-failure discipline as the pre-EXT-034 `_callLLM` — no
    // fabricated AI response when nothing configured is reachable.
    const error = new Error(`AI service is not available: no configured provider (tried [${candidates.map((c) => c.provider).join(", ")}]) could be reached. ${attemptErrors.join("; ")}`);
    error.code = "AI_UNAVAILABLE";
    throw error;
  }

  static async _fireShadowTest({ tenantId, branchId, category, correlationId, primaryProvider, primaryModel, primaryResult, params, shadowProvider, shadowModel }) {
    if (mongoose.connection?.readyState !== 1) return;
    const adapter = this._getAdapter(shadowProvider);
    if (!adapter?.isConfigured()) return;

    const startedAt = Date.now();
    let shadowResult = null;
    let shadowSucceeded = true;
    let shadowErrorMessage = null;
    try {
      shadowResult = await adapter.chatWithTools({ ...params, model: shadowModel || undefined });
    } catch (err) {
      shadowSucceeded = false;
      shadowErrorMessage = err.message;
    }

    const resolvedShadowModel = shadowModel || getAIModelConfig().providers[shadowProvider]?.model || null;
    AIShadowTestResultModel.create({
      tenantId, branchId, category, correlationId,
      primaryProvider, primaryModel, primaryContentExcerpt: (primaryResult.content || "").slice(0, 500), primaryToolCallCount: (primaryResult.toolCalls || []).length,
      shadowProvider, shadowModel: resolvedShadowModel,
      shadowContentExcerpt: shadowResult ? (shadowResult.content || "").slice(0, 500) : null,
      shadowToolCallCount: shadowResult ? (shadowResult.toolCalls || []).length : 0,
      shadowLatencyMs: Date.now() - startedAt, shadowSucceeded, shadowErrorMessage,
      contentLengthDeltaChars: shadowResult ? (shadowResult.content || "").length - (primaryResult.content || "").length : null,
      toolCallDecisionMatched: shadowResult
        ? (primaryResult.toolCalls || []).map((t) => t.name).sort().join(",") === (shadowResult.toolCalls || []).map((t) => t.name).sort().join(",")
        : null
    }).catch((err) => logger.error("AI shadow test result persistence failed.", { error: err.message }));
  }

  /** §12 "Model Versioning" / §13 "Capability Matrix" — the real, live catalog (never a fabricated one), including disabled entries so an operator can see what COULD be turned on. */
  static getModelCatalog() {
    const config = getAIModelConfig();
    return Object.entries(config.providers).map(([name, p]) => ({
      provider: name, model: p.model, enabled: p.enabled, categories: p.categories, capabilities: p.capabilities,
      costPerThousandTokens: p.costPerThousandTokens, priority: p.priority
    }));
  }

  /** §11 "Provider Health" — every catalog provider, configured or not (an unconfigured one reports NOT_CONFIGURED, same as before this document). */
  static async getProviderStatus() {
    const config = getAIModelConfig();
    const statuses = {};
    for (const name of Object.keys(config.providers)) {
      const adapter = this._getAdapter(name);
      const health = await adapter.checkHealth();
      statuses[name] = { ...health, circuitBreaker: this.circuitBreaker.getStatus(name), categories: config.providers[name].categories, priority: config.providers[name].priority };
    }
    return statuses;
  }

  // ---- Routing policy CRUD (§9/§14) ----

  static async upsertRoutingPolicy({ tenantId, branchId = "main", userId, category, preferredProviders, costOptimized, shadowProvider, shadowModel, isActive }) {
    const config = getAIModelConfig();
    if (!category || !config.categories.includes(category)) throw new Error(`category is required and must be one of: ${config.categories.join(", ")}.`);
    if (preferredProviders) {
      const unknown = preferredProviders.filter((p) => !config.providers[p]);
      if (unknown.length > 0) throw new Error(`Unknown provider(s) in preferredProviders: ${unknown.join(", ")}.`);
    }
    if (shadowProvider && !config.providers[shadowProvider]) throw new Error(`Unknown shadowProvider '${shadowProvider}'.`);

    const update = { updatedBy: userId };
    if (preferredProviders !== undefined) update.preferredProviders = preferredProviders;
    if (costOptimized !== undefined) update.costOptimized = costOptimized;
    if (shadowProvider !== undefined) update.shadowProvider = shadowProvider;
    if (shadowModel !== undefined) update.shadowModel = shadowModel;
    if (isActive !== undefined) update.isActive = isActive;

    const policy = await AIRoutingPolicyModel.findOneAndUpdate(
      { tenantId, branchId, category },
      { $set: update, $setOnInsert: { createdBy: userId } },
      { upsert: true, new: true }
    );
    publishEvent("AIRoutingPolicyUpdated", { tenantId, category, policyId: policy._id });
    return policy;
  }

  static async listRoutingPolicies({ tenantId, branchId }) {
    const filter = { tenantId };
    if (branchId) filter.branchId = branchId;
    return AIRoutingPolicyModel.find(filter).sort({ category: 1 }).lean();
  }

  static async deleteRoutingPolicy({ tenantId, branchId = "main", category }) {
    const policy = await AIRoutingPolicyModel.findOneAndDelete({ tenantId, branchId, category });
    if (!policy) throw new Error("Routing policy not found.");
    publishEvent("AIRoutingPolicyDeleted", { tenantId, category });
    return policy;
  }

  // ---- A/B testing (§16) ----

  static async createABTest({ tenantId, branchId = "main", userId, category, name, description, variantA, variantB, trafficSplitPct = 50 }) {
    const config = getAIModelConfig();
    if (!category || !config.categories.includes(category)) throw new Error(`category is required and must be one of: ${config.categories.join(", ")}.`);
    if (!name || !name.trim()) throw new Error("name is required.");
    if (!variantA?.provider || !config.providers[variantA.provider]) throw new Error("variantA.provider is required and must be a real catalog provider.");
    if (!variantB?.provider || !config.providers[variantB.provider]) throw new Error("variantB.provider is required and must be a real catalog provider.");
    if (trafficSplitPct < 1 || trafficSplitPct > 99) throw new Error("trafficSplitPct must be between 1 and 99.");

    const test = await AIABTestModel.create({
      tenantId, branchId, category, name: name.trim(), description: description || null,
      variantA, variantB, trafficSplitPct, status: "draft", createdBy: userId
    });
    publishEvent("AIABTestCreated", { tenantId, testId: test._id, category });
    return test;
  }

  static async startABTest({ tenantId, testId }) {
    const test = await AIABTestModel.findOne({ _id: testId, tenantId });
    if (!test) throw new Error("A/B test not found.");
    if (test.status !== "draft") throw new Error(`Cannot start a test that is '${test.status}' (must be 'draft').`);
    const alreadyRunning = await AIABTestModel.exists({ tenantId, branchId: test.branchId, category: test.category, status: "running" });
    if (alreadyRunning) throw new Error(`Another A/B test is already running for category '${test.category}'. Only one may run at a time per category.`);

    test.status = "running";
    test.startedAt = new Date();
    await test.save();
    publishEvent("AIABTestStarted", { tenantId, testId: test._id, category: test.category });
    return test;
  }

  static async cancelABTest({ tenantId, testId }) {
    const test = await AIABTestModel.findOne({ _id: testId, tenantId });
    if (!test) throw new Error("A/B test not found.");
    if (!["draft", "running"].includes(test.status)) throw new Error(`Cannot cancel a test that is already '${test.status}'.`);
    test.status = "cancelled";
    test.endedAt = new Date();
    await test.save();
    publishEvent("AIABTestCancelled", { tenantId, testId: test._id });
    return test;
  }

  static async listABTests({ tenantId, category, status, page = 1, pageSize = 20 }) {
    const safePage = Math.max(parseInt(page, 10) || 1, 1);
    const safePageSize = Math.min(Math.max(parseInt(pageSize, 10) || 20, 1), 100);
    const filter = { tenantId };
    if (category) filter.category = category;
    if (status) filter.status = status;
    const [items, totalItems] = await Promise.all([
      AIABTestModel.find(filter).sort({ createdAt: -1 }).skip((safePage - 1) * safePageSize).limit(safePageSize).lean(),
      AIABTestModel.countDocuments(filter)
    ]);
    return { items, pagination: { page: safePage, pageSize: safePageSize, totalItems, totalPages: Math.ceil(totalItems / safePageSize) || 1 } };
  }

  /** Real per-variant results, aggregated straight from EXT-033's AIRequestMetricModel rows tagged during route() — never simulated. */
  static async getABTestResults({ tenantId, testId }) {
    const test = await AIABTestModel.findOne({ _id: testId, tenantId }).lean();
    if (!test) throw new Error("A/B test not found.");

    const empty = { requests: 0, successRatePct: null, averageDurationMs: null, averageCostUsd: null, totalCostUsd: 0 };
    if (mongoose.connection?.readyState !== 1) return { test, results: { A: empty, B: empty } };

    const rows = await AIRequestMetricModel.aggregate([
      { $match: { tenantId, abTestId: test._id } },
      { $group: { _id: "$abVariant", requests: { $sum: 1 }, succeeded: { $sum: { $cond: ["$succeeded", 1, 0] } }, avgDurationMs: { $avg: "$durationMs" }, avgCostUsd: { $avg: "$estimatedCostUsd" }, totalCostUsd: { $sum: "$estimatedCostUsd" } } }
    ]);

    const byVariant = {};
    for (const row of rows) {
      byVariant[row._id] = {
        requests: row.requests,
        successRatePct: row.requests > 0 ? Number(((row.succeeded / row.requests) * 100).toFixed(1)) : null,
        averageDurationMs: row.avgDurationMs != null ? Math.round(row.avgDurationMs) : null,
        averageCostUsd: row.avgCostUsd != null ? Number(row.avgCostUsd.toFixed(6)) : null,
        totalCostUsd: Number((row.totalCostUsd || 0).toFixed(6))
      };
    }
    return { test, results: { A: byVariant.A || empty, B: byVariant.B || empty } };
  }

  /**
   * §16 "Winner promoted automatically after approval." The comparison is
   * real (getABTestResults); the actual DECISION is always a human's — this
   * method only ever runs when explicitly called with an admin-chosen
   * winner, never a fully autonomous selection. Promoting writes a real
   * AIRoutingPolicyModel row so future routing for this category genuinely
   * prefers the winning (provider, model) — the fallback chain behind it is
   * kept, not replaced, so promotion never removes failover safety.
   */
  static async promoteABTestWinner({ tenantId, userId, testId, winner }) {
    if (!["A", "B"].includes(winner)) throw new Error("winner must be 'A' or 'B'.");
    const test = await AIABTestModel.findOne({ _id: testId, tenantId });
    if (!test) throw new Error("A/B test not found.");
    if (test.status !== "running") throw new Error(`Cannot promote a winner for a test that is '${test.status}' (must be 'running').`);

    test.status = "completed";
    test.winner = winner;
    test.endedAt = new Date();
    test.promotedBy = userId;
    test.promotedAt = new Date();
    await test.save();

    const variant = winner === "A" ? test.variantA : test.variantB;
    const config = getAIModelConfig();
    const promotedOrder = [variant.provider, ...config.defaultRoutingOrder.filter((p) => p !== variant.provider)];
    await AIRoutingPolicyModel.findOneAndUpdate(
      { tenantId, branchId: test.branchId, category: test.category },
      { $set: { preferredProviders: promotedOrder, preferredModelOverride: { provider: variant.provider, model: variant.model || null }, isActive: true, updatedBy: userId }, $setOnInsert: { createdBy: userId } },
      { upsert: true, new: true }
    );

    publishEvent("AIABTestWinnerPromoted", { tenantId, testId: test._id, category: test.category, winner, provider: variant.provider, model: variant.model || null });
    return test;
  }

  static async listShadowTestResults({ tenantId, category, page = 1, pageSize = 20 }) {
    const safePage = Math.max(parseInt(page, 10) || 1, 1);
    const safePageSize = Math.min(Math.max(parseInt(pageSize, 10) || 20, 1), 100);
    const filter = { tenantId };
    if (category) filter.category = category;
    const [items, totalItems] = await Promise.all([
      AIShadowTestResultModel.find(filter).sort({ createdAt: -1 }).skip((safePage - 1) * safePageSize).limit(safePageSize).lean(),
      AIShadowTestResultModel.countDocuments(filter)
    ]);
    return { items, pagination: { page: safePage, pageSize: safePageSize, totalItems, totalPages: Math.ceil(totalItems / safePageSize) || 1 } };
  }
}

export default AIModelRouterService;
