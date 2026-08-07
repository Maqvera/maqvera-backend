import mongoose from "mongoose";
import AIPromptModel from "../models/AIPromptModel.js";
import AIPromptVersionModel from "../models/AIPromptVersionModel.js";
import AIPromptTestCaseModel from "../models/AIPromptTestCaseModel.js";
import AuditLogModel from "../models/AuditLogmodel.js";
import OpenAIAdapter from "./ai/OpenAIAdapter.js";
import AnthropicAdapter from "./ai/AnthropicAdapter.js";
import CacheManager from "../utils/cacheManager.js";
import { getAIPromptConfig } from "../utils/aiPromptConfig.js";
import { DEFAULT_SYSTEM_PROMPT, DEFAULT_WORKFLOW_PROMPTS } from "../utils/aiPromptDefaults.js";
import { publishEvent } from "../utils/eventBus.js";

/** §12 "Prompt Lifecycle." A real state machine — every transition is checked against this, not accepted as a free-form status write. */
const ALLOWED_TRANSITIONS = {
  draft: ["review", "archived"],
  review: ["testing", "draft", "rejected"],
  testing: ["approved", "review", "rejected"],
  approved: ["published", "review"],
  published: ["archived"],
  rejected: ["draft", "archived"],
  archived: []
};

const cacheKey = (tenantId, branchId, promptType, key, language) => `aiprompt:${tenantId}:${branchId}:${promptType}:${key}:${language}`;

class AIPromptService {
  static adapters = { OpenAI: new OpenAIAdapter(), Anthropic: new AnthropicAdapter() };

  static async _callLLMForTest({ systemPrompt, userMessage }) {
    for (const adapter of Object.values(this.adapters)) {
      if (!adapter.isConfigured()) continue;
      try {
        return await adapter.chatWithTools({ messages: [{ role: "user", content: userMessage }], tools: [], systemPrompt });
      } catch {
        // try the next configured provider
      }
    }
    const error = new Error("AI service is not available: no configured provider (OPENAI_API_KEY / ANTHROPIC_API_KEY) could run this prompt test.");
    error.code = "AI_UNAVAILABLE";
    throw error;
  }

  /** §10 "Prompt Variables ... injected dynamically." Unknown placeholders are left as literal text — observable/debuggable rather than silently dropped or throwing on a template that references a variable this call site didn't provide. */
  static interpolate(template, variables = {}) {
    return template.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (match, name) => (Object.prototype.hasOwnProperty.call(variables, name) && variables[name] != null ? String(variables[name]) : match));
  }

  static async _validatePromptType(promptType) {
    const { promptTypes } = getAIPromptConfig();
    if (!promptTypes.includes(promptType)) throw new Error(`Invalid promptType '${promptType}'. Must be one of: ${promptTypes.join(", ")}.`);
  }

  static async createPrompt({ tenantId, branchId, userId, promptType, key, language, name, description, content }) {
    if (!key || !key.trim()) throw new Error("key is required.");
    if (!name || !name.trim()) throw new Error("name is required.");
    if (!content || !content.trim()) throw new Error("content is required.");
    await this._validatePromptType(promptType);
    const { supportedLanguages, defaultLanguage } = getAIPromptConfig();
    const resolvedLanguage = language || defaultLanguage;
    if (!supportedLanguages.includes(resolvedLanguage)) throw new Error(`Unsupported language '${resolvedLanguage}'. Must be one of: ${supportedLanguages.join(", ")}.`);

    const existing = await AIPromptModel.findOne({ tenantId, branchId: branchId || "main", promptType, key, language: resolvedLanguage });
    if (existing) throw new Error(`A prompt already exists for (promptType='${promptType}', key='${key}', language='${resolvedLanguage}'). Use createVersion to add a new version to it.`);

    const prompt = await AIPromptModel.create({ tenantId, branchId: branchId || "main", promptType, key, language: resolvedLanguage, name, description: description || null, createdBy: userId });
    const version = await AIPromptVersionModel.create({ promptId: prompt._id, tenantId, version: 1, content, language: resolvedLanguage, description: description || null, status: "draft", author: userId });

    publishEvent("AIPromptCreated", { promptId: prompt._id, tenantId, promptType, key, language: resolvedLanguage });
    return { prompt, version };
  }

  static async createVersion({ tenantId, userId, promptId, content, description }) {
    if (!content || !content.trim()) throw new Error("content is required.");
    const prompt = await AIPromptModel.findOne({ _id: promptId, tenantId });
    if (!prompt) throw new Error("Prompt not found.");

    const latest = await AIPromptVersionModel.findOne({ promptId }).sort({ version: -1 }).select("version").lean();
    const nextVersion = (latest?.version || 0) + 1;

    const version = await AIPromptVersionModel.create({ promptId, tenantId, version: nextVersion, content, language: prompt.language, description: description || null, status: "draft", author: userId });
    publishEvent("AIPromptVersionCreated", { promptId, tenantId, version: nextVersion });
    return version;
  }

  /**
   * §12/§19 lifecycle transition. Publishing (the only transition that
   * changes what's actually served to the AI) requires the dedicated
   * publish permission — "Only authorized administrators may publish
   * prompts" — and is the one branch with real side effects: the
   * previously-published version (if any) is archived, the parent's
   * pointer moves to this version, and the resolve cache is invalidated
   * so the change is live immediately (§14 "No API restart required"),
   * never waiting out the TTL.
   */
  static async transitionVersionStatus({ tenantId, userId, permissions = [], promptId, version, newStatus, reason }) {
    const { lifecycleStatuses, publishPermission } = getAIPromptConfig();
    if (!lifecycleStatuses.includes(newStatus)) throw new Error(`Invalid status '${newStatus}'.`);

    const prompt = await AIPromptModel.findOne({ _id: promptId, tenantId });
    if (!prompt) throw new Error("Prompt not found.");
    const versionDoc = await AIPromptVersionModel.findOne({ promptId, tenantId, version });
    if (!versionDoc) throw new Error("Prompt version not found.");

    const allowed = ALLOWED_TRANSITIONS[versionDoc.status] || [];
    if (!allowed.includes(newStatus)) throw new Error(`Cannot transition a prompt version from '${versionDoc.status}' to '${newStatus}'. Allowed: ${allowed.join(", ") || "(none — terminal state)"}.`);

    if (newStatus === "published") {
      if (!permissions.includes(publishPermission) && !permissions.includes("admin")) {
        throw new Error(`Only a user with the '${publishPermission}' permission (or admin) can publish a prompt.`);
      }
      return this._publishVersion({ prompt, versionDoc, userId, isRollback: false });
    }

    versionDoc.status = newStatus;
    await versionDoc.save();
    publishEvent("AIPromptVersionStatusChanged", { promptId, tenantId, version, status: newStatus, reason: reason || null });
    return versionDoc;
  }

  static async _publishVersion({ prompt, versionDoc, userId, isRollback }) {
    if (prompt.currentPublishedVersion && String(prompt.currentPublishedVersion) !== String(versionDoc._id)) {
      await AIPromptVersionModel.updateOne({ _id: prompt.currentPublishedVersion }, { $set: { status: "archived", archivedAt: new Date() } });
    }

    versionDoc.status = "published";
    versionDoc.publishedBy = userId;
    versionDoc.publishedAt = new Date();
    versionDoc.isRollback = isRollback;
    await versionDoc.save();

    prompt.currentPublishedVersion = versionDoc._id;
    await prompt.save();

    await CacheManager.invalidate(cacheKey(prompt.tenantId, prompt.branchId, prompt.promptType, prompt.key, prompt.language));

    if (mongoose.connection?.readyState === 1) {
      AuditLogModel.create({
        tenantId: prompt.tenantId, userId, action: isRollback ? "AI_PROMPT_ROLLED_BACK" : "AI_PROMPT_PUBLISHED", module: "AIPromptManagement",
        targetId: versionDoc._id.toString(), details: { promptId: prompt._id.toString(), promptType: prompt.promptType, key: prompt.key, version: versionDoc.version }
      }).catch((err) => console.error("AI prompt publish audit log error:", err));
    }

    publishEvent(isRollback ? "AIPromptRolledBack" : "AIPromptPublished", { promptId: prompt._id, tenantId: prompt.tenantId, version: versionDoc.version });
    return versionDoc;
  }

  /** §15 "Rollback — Select Previous Version -> Publish -> Instant Rollback -> Audit Logged." Republishes ANY earlier version (any status — a rollback target doesn't need to independently walk back through the review/testing/approved chain first, since it already passed that chain the first time it was published). */
  static async rollback({ tenantId, userId, permissions = [], promptId, targetVersion }) {
    const { publishPermission } = getAIPromptConfig();
    if (!permissions.includes(publishPermission) && !permissions.includes("admin")) {
      throw new Error(`Only a user with the '${publishPermission}' permission (or admin) can roll back a prompt.`);
    }
    const prompt = await AIPromptModel.findOne({ _id: promptId, tenantId });
    if (!prompt) throw new Error("Prompt not found.");
    const versionDoc = await AIPromptVersionModel.findOne({ promptId, tenantId, version: targetVersion });
    if (!versionDoc) throw new Error("Target prompt version not found.");
    if (String(prompt.currentPublishedVersion) === String(versionDoc._id)) throw new Error("This version is already the published one.");

    return this._publishVersion({ prompt, versionDoc, userId, isRollback: true });
  }

  static async listPrompts({ tenantId, branchId, promptType, page = 1, pageSize = 20 }) {
    const safePage = Math.max(parseInt(page, 10) || 1, 1);
    const safePageSize = Math.min(Math.max(parseInt(pageSize, 10) || 20, 1), 100);
    const filter = { tenantId };
    if (branchId) filter.branchId = { $in: [branchId, "main"] };
    if (promptType) filter.promptType = promptType;

    const [items, totalItems] = await Promise.all([
      AIPromptModel.find(filter).sort({ updatedAt: -1 }).skip((safePage - 1) * safePageSize).limit(safePageSize).populate("currentPublishedVersion", "version status publishedAt").lean(),
      AIPromptModel.countDocuments(filter)
    ]);
    return { items, pagination: { page: safePage, pageSize: safePageSize, totalItems, totalPages: Math.ceil(totalItems / safePageSize) || 1 } };
  }

  static async getPromptWithVersions({ tenantId, promptId }) {
    const prompt = await AIPromptModel.findOne({ _id: promptId, tenantId }).lean();
    if (!prompt) throw new Error("Prompt not found.");
    const versions = await AIPromptVersionModel.find({ promptId, tenantId }).sort({ version: -1 }).select("-testRuns.results.actualOutputExcerpt").lean();
    return { prompt, versions };
  }

  /**
   * The read path every real LLM call goes through. Cache-wrapped (§14)
   * so a hot prompt doesn't hit the DB on every single request; publish/
   * rollback explicitly invalidate this exact key so the cache can never
   * serve a stale published version. Returns null — never throws, never
   * fabricates content — when nothing is published; the caller (see
   * composeChatPrompt/composeWorkflowPrompt) falls back to the real
   * relocated defaults in utils/aiPromptDefaults.js.
   */
  static async resolvePrompt({ tenantId, branchId, promptType, key, language }) {
    const { defaultLanguage, cacheTtlSeconds } = getAIPromptConfig();
    const resolvedLanguage = language || defaultLanguage;
    const { data } = await CacheManager.getOrCompute(
      cacheKey(tenantId, branchId || "main", promptType, key, resolvedLanguage),
      async () => {
        const prompt = await AIPromptModel.findOne({ tenantId, branchId: { $in: [branchId || "main", "main"] }, promptType, key, language: resolvedLanguage })
          .populate("currentPublishedVersion", "version content status")
          .lean();
        const published = prompt?.currentPublishedVersion;
        if (!published || published.status !== "published") return null;
        return { promptId: prompt._id, versionId: published._id, version: published.version, content: published.content };
      },
      cacheTtlSeconds
    );
    return data;
  }

  /** §20 "Monitoring." Only called for a version actually resolved from the DB — the hardcoded fallback in utils/aiPromptDefaults.js has no versionId to attribute usage to, and correctly records nothing (there's nothing an admin could act on for content they don't control). */
  static async recordUsage({ versionId, latencyMs, tokens, succeeded }) {
    if (!versionId || mongoose.connection?.readyState !== 1) return;
    await AIPromptVersionModel.updateOne(
      { _id: versionId },
      { $inc: { "usage.executionCount": 1, "usage.successCount": succeeded ? 1 : 0, "usage.failureCount": succeeded ? 0 : 1, "usage.totalLatencyMs": latencyMs || 0, "usage.totalTokens": tokens || 0 } }
    ).catch((err) => console.error("AI prompt usage recording error:", err.message));
  }

  /**
   * §17 "Prompt Composition — System + Role + Workflow + Retrieved
   * Knowledge + Conversation Memory + User Request." Retrieved Knowledge
   * is deliberately NOT assembled here: EXT-030 made knowledge retrieval a
   * tool the model calls on demand (consistent with every other
   * capability in this codebase being tool-driven, not an automatic
   * pre-step), so it reaches the model through conversation history via
   * the tool-result message, not the system prompt. Conversation Memory
   * (EXT-027) IS appended here, same as before this document's changes.
   */
  static async composeChatPrompt({ tenantId, branchId, mode, role, language, variables = {}, memorySummary }) {
    const systemResolved = await this.resolvePrompt({ tenantId, branchId, promptType: "system", key: "default", language });
    const systemTemplate = systemResolved || { content: DEFAULT_SYSTEM_PROMPT.content, versionId: null };
    let text = this.interpolate(systemTemplate.content, variables);
    const versionRefs = [];
    if (systemResolved) versionRefs.push({ promptType: "system", key: "default", versionId: systemResolved.versionId });

    if (mode) {
      const roleResolved = await this.resolvePrompt({ tenantId, branchId, promptType: "role", key: mode, language });
      if (roleResolved) {
        text += `\n\nROLE-SPECIFIC INSTRUCTIONS (${mode}):\n${this.interpolate(roleResolved.content, variables)}`;
        versionRefs.push({ promptType: "role", key: mode, versionId: roleResolved.versionId });
      }
    }

    const guardrailResolved = await this.resolvePrompt({ tenantId, branchId, promptType: "guardrail", key: "default", language });
    if (guardrailResolved) {
      text += `\n\nADDITIONAL GUARDRAILS:\n${this.interpolate(guardrailResolved.content, variables)}`;
      versionRefs.push({ promptType: "guardrail", key: "default", versionId: guardrailResolved.versionId });
    }

    if (memorySummary) {
      text += `\n\nKNOWN CONTEXT FROM THIS SESSION (remembered from earlier in this conversation — reuse these details instead of asking the user again, and use them to fill in missing tool arguments; only ask the user for a field that is genuinely missing from both their current message and this remembered context):\n${memorySummary}`;
    }

    return { text, versionRefs };
  }

  /** Same resolve-with-fallback pattern as composeChatPrompt, scoped to a single "workflow" prompt (planning/synthesis/...). */
  static async composeWorkflowPrompt({ tenantId, branchId, key, language, variables = {} }) {
    const resolved = await this.resolvePrompt({ tenantId, branchId, promptType: "workflow", key, language });
    const fallback = DEFAULT_WORKFLOW_PROMPTS[key];
    const template = resolved || fallback;
    if (!template) throw new Error(`No published workflow prompt and no default exists for key '${key}'.`);
    const text = this.interpolate(template.content, variables);
    return { text, versionRef: resolved ? { promptType: "workflow", key, versionId: resolved.versionId } : null };
  }

  // ── Prompt Testing (§13) ────────────────────────────────────────────

  static async createTestCase({ tenantId, userId, promptId, name, variables, userMessage, expectedContains, expectedNotContains }) {
    const prompt = await AIPromptModel.findOne({ _id: promptId, tenantId });
    if (!prompt) throw new Error("Prompt not found.");
    if (!name || !name.trim()) throw new Error("name is required.");
    if (!userMessage || !userMessage.trim()) throw new Error("userMessage is required.");
    return AIPromptTestCaseModel.create({
      promptId, tenantId, name, variables: variables || {}, userMessage,
      expectedContains: Array.isArray(expectedContains) ? expectedContains : [],
      expectedNotContains: Array.isArray(expectedNotContains) ? expectedNotContains : [],
      createdBy: userId
    });
  }

  static async listTestCases({ tenantId, promptId }) {
    return AIPromptTestCaseModel.find({ tenantId, promptId, isActive: true }).sort({ createdAt: -1 }).lean();
  }

  static async deleteTestCase({ tenantId, testCaseId }) {
    const testCase = await AIPromptTestCaseModel.findOne({ _id: testCaseId, tenantId });
    if (!testCase) throw new Error("Test case not found.");
    testCase.isActive = false;
    await testCase.save();
    return testCase;
  }

  /**
   * §13 "Regression Tests ... Expected Outputs ... Quality Scores." Runs
   * the prompt's real active test cases against a SPECIFIC version's real
   * content, via a genuine LLM call — checked against real, literal
   * substring assertions. Never an LLM asked to grade another LLM's
   * output (that would just be an unverified opinion, not a measurement).
   */
  static async runTestSuite({ tenantId, userId, promptId, version }) {
    const versionDoc = await AIPromptVersionModel.findOne({ promptId, tenantId, version });
    if (!versionDoc) throw new Error("Prompt version not found.");
    const testCases = await AIPromptTestCaseModel.find({ tenantId, promptId, isActive: true });
    if (testCases.length === 0) throw new Error("This prompt has no active test cases to run.");

    const results = [];
    for (const testCase of testCases) {
      const systemPrompt = this.interpolate(versionDoc.content, testCase.variables || {});
      try {
        const llmResult = await this._callLLMForTest({ systemPrompt, userMessage: testCase.userMessage });
        const output = llmResult.content || "";
        const missingContains = (testCase.expectedContains || []).filter((phrase) => !output.toLowerCase().includes(phrase.toLowerCase()));
        const unexpectedContains = (testCase.expectedNotContains || []).filter((phrase) => output.toLowerCase().includes(phrase.toLowerCase()));
        const passed = missingContains.length === 0 && unexpectedContains.length === 0;
        results.push({ testCaseId: testCase._id, passed, actualOutputExcerpt: output.slice(0, 500), missingContains, unexpectedContains, error: null });
      } catch (err) {
        results.push({ testCaseId: testCase._id, passed: false, actualOutputExcerpt: null, missingContains: [], unexpectedContains: [], error: err.message });
      }
    }

    const passRate = Number(((results.filter((r) => r.passed).length / results.length) * 100).toFixed(1));
    versionDoc.testRuns.push({ ranAt: new Date(), ranBy: userId, results, passRate });
    await versionDoc.save();

    publishEvent("AIPromptTestSuiteRun", { promptId, tenantId, version, passRate, testCaseCount: testCases.length });
    return { passRate, results, testCaseCount: testCases.length };
  }

  /** §20 "Monitoring — Execution Count, Average Latency, Token Usage, Success Rate, Quality Score." Real aggregation over this prompt's own version usage counters and latest test-run pass rates — never a fabricated figure. */
  static async getPromptMetrics({ tenantId, promptId }) {
    const versions = await AIPromptVersionModel.find({ promptId, tenantId }).select("version status usage testRuns").lean();
    return versions.map((v) => ({
      version: v.version,
      status: v.status,
      executionCount: v.usage.executionCount,
      successRate: v.usage.executionCount > 0 ? Number(((v.usage.successCount / v.usage.executionCount) * 100).toFixed(1)) : null,
      averageLatencyMs: v.usage.executionCount > 0 ? Math.round(v.usage.totalLatencyMs / v.usage.executionCount) : null,
      averageTokens: v.usage.executionCount > 0 ? Math.round(v.usage.totalTokens / v.usage.executionCount) : null,
      latestQualityScore: v.testRuns.length > 0 ? v.testRuns[v.testRuns.length - 1].passRate : null,
      testRunCount: v.testRuns.length
    }));
  }
}

export default AIPromptService;
