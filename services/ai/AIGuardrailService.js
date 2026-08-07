import mongoose from "mongoose";
import AIPolicyModel from "../../models/AIPolicyModel.js";
import AIGuardrailAuditModel from "../../models/AIGuardrailAuditModel.js";
import EnterpriseIncidentEngineService from "../EnterpriseIncidentEngineService.js";
import { getAIGuardrailConfig } from "../../utils/aiGuardrailConfig.js";
import { publishEvent } from "../../utils/eventBus.js";

const RISK_RANK = { low: 0, medium: 1, high: 2, critical: 3 };

/**
 * EXT-032 "AI Safety, Guardrails & Policy Enforcement" — the real Policy
 * Engine + Risk Analyzer + Prompt Injection Detector + Response Validator
 * behind the doc's "User -> Policy Engine -> Permission Validation ->
 * Business Validation -> Approval Check -> Tool Execution -> Audit ->
 * Response" flow.
 *
 * "Permission Validation" itself is NOT duplicated here — AIToolRegistry's
 * existing `requiredPermissions` check (unchanged, still the first gate in
 * execute()) already is that, real and enforced since EXT-026. This service
 * owns everything downstream of it: risk scoring, tenant-configurable
 * policy enforcement, prompt-injection defense-in-depth, sensitive-data
 * masking, and response validation — deliberately NOT
 * AIToolRegistry-aware (no import of it, and no import back from it beyond
 * a one-directional AIToolRegistry -> AIGuardrailService call), so the
 * caller passes in `toolRiskLevel` rather than this service looking the
 * tool up itself — avoiding a circular module dependency between the two.
 */
class AIGuardrailService {
  /** "Prompt Injection Protection" — a real, bounded heuristic (regex phrase list), not a claim of foolproof detection. */
  static detectPromptInjection(text) {
    if (!text) return false;
    const { promptInjectionPatterns } = getAIGuardrailConfig();
    const lower = String(text).toLowerCase();
    return promptInjectionPatterns.some((pattern) => new RegExp(pattern, "i").test(lower));
  }

  /**
   * §8 "Sensitive Data Protection" — field-NAME based scan (the reliable
   * signal for structured tool arguments). Bounded recursion depth so an
   * unusual payload shape can't cause runaway recursion.
   */
  static scanSensitiveFields(obj, depth = 0, found = []) {
    if (!obj || typeof obj !== "object" || depth > 3) return found;
    const { sensitiveFieldNamePatterns } = getAIGuardrailConfig();
    for (const [key, value] of Object.entries(obj)) {
      if (sensitiveFieldNamePatterns.some((p) => new RegExp(p, "i").test(key))) {
        found.push(key);
      } else if (value && typeof value === "object") {
        this.scanSensitiveFields(value, depth + 1, found);
      }
    }
    return found;
  }

  /** Masks sensitive-looking substrings (credit-card/CNIC/IBAN-shaped) inside free text, keeping the last 4 characters visible. */
  static maskValue(str) {
    if (typeof str !== "string" || !str) return str;
    const { sensitiveValuePatterns } = getAIGuardrailConfig();
    let masked = str;
    for (const pattern of sensitiveValuePatterns) {
      masked = masked.replace(new RegExp(pattern, "g"), (match) => {
        const keep = 4;
        return match.length <= keep ? "*".repeat(match.length) : "*".repeat(match.length - keep) + match.slice(-keep);
      });
    }
    return masked;
  }

  /**
   * Deep-masks a value for STORAGE/DISPLAY purposes only (conversation
   * transcripts, tool-execution history, audit logs) — never applied to the
   * real arguments a tool handler actually executes with. A field whose KEY
   * matches a known sensitive-data name is fully replaced; every other
   * string is scanned for sensitive-shaped substrings via maskValue.
   */
  static maskSensitiveData(value, depth = 0) {
    if (depth > 5 || value == null) return value;
    if (typeof value === "string") return this.maskValue(value);
    if (Array.isArray(value)) return value.map((v) => this.maskSensitiveData(v, depth + 1));
    if (typeof value === "object") {
      const { sensitiveFieldNamePatterns } = getAIGuardrailConfig();
      const out = {};
      for (const [key, val] of Object.entries(value)) {
        out[key] = sensitiveFieldNamePatterns.some((p) => new RegExp(p, "i").test(key)) ? "***MASKED***" : this.maskSensitiveData(val, depth + 1);
      }
      return out;
    }
    return value;
  }

  /**
   * §14 "Risk Levels — Low/Medium/High/Critical. Risk determines Approval,
   * Logging, Escalation, Monitoring." A real, transparent, additive score —
   * not a fabricated certainty number, same honesty precedent as
   * AIAssistantService's own confidenceScore.
   */
  static assessRisk({ toolRiskLevel, promptInjectionFlagged = false, sensitiveFieldsFound = [] }) {
    const config = getAIGuardrailConfig();
    let score = config.riskBaseScoreByToolRiskLevel[toolRiskLevel] ?? config.riskBaseScoreByToolRiskLevel.high;
    const reasons = [`Base risk for tool risk level '${toolRiskLevel}': ${score}`];

    if (promptInjectionFlagged) {
      score += config.riskScoreForInjectionFlag;
      reasons.push(`+${config.riskScoreForInjectionFlag} — this turn's message was flagged as a possible prompt injection attempt`);
    }
    if (sensitiveFieldsFound.length > 0) {
      const add = config.riskScoreForSensitiveField * sensitiveFieldsFound.length;
      score += add;
      reasons.push(`+${add} — sensitive field(s) present in arguments: ${sensitiveFieldsFound.join(", ")}`);
    }
    score = Math.max(0, Math.min(100, score));

    const { riskThresholds } = config;
    let riskLevel = "low";
    if (score >= riskThresholds.critical) riskLevel = "critical";
    else if (score >= riskThresholds.high) riskLevel = "high";
    else if (score >= riskThresholds.medium) riskLevel = "medium";

    return { riskScore: score, riskLevel, reasons };
  }

  /**
   * The Policy Engine's real decision point. Only meant to be called for
   * non-read tools (see AIToolRegistry.execute's own scoping note) — read
   * tools have nothing meaningful to be blocked from and calling this for
   * every search would add an unnecessary DB round trip to the hot path.
   */
  static async evaluate({ tenantId, branchId = "main", userId, role = "", permissions = [], toolName, toolRiskLevel, args = {}, promptInjectionFlagged = false, correlationId = null }) {
    const config = getAIGuardrailConfig();
    const sensitiveFieldsFound = this.scanSensitiveFields(args);
    const risk = this.assessRisk({ toolRiskLevel, promptInjectionFlagged, sensitiveFieldsFound });

    let decision = "allowed";
    let reason = null;
    let matchedPolicyId = null;

    // §9 "Prompt injection detected before execution" — defense-in-depth,
    // checked before any DB policy lookup and independent of tenant policy
    // configuration.
    if (config.blockNonReadToolsOnInjection && promptInjectionFlagged && toolRiskLevel !== "read") {
      decision = "blocked";
      reason = "Blocked: this turn's message was flagged as a possible prompt injection attempt, and this action is not a read-only operation.";
    }

    // §5 "Policies configurable" — real, tenant-defined DB rows.
    if (decision === "allowed" && mongoose.connection?.readyState === 1) {
      const policies = await AIPolicyModel.find({ tenantId, isActive: true, $or: [{ toolName }, { toolName: null }] }).lean();
      const isAdmin = permissions.includes("admin") || permissions.includes("superadmin");

      for (const policy of policies) {
        if (policy.ruleType === "block_tool") {
          decision = "blocked";
          reason = `Blocked by policy '${policy.name}': this action is disabled by tenant policy.`;
          matchedPolicyId = policy._id;
          break;
        }
        if (policy.ruleType === "restrict_role") {
          const allowed = (policy.allowedRoles || []).map((r) => r.toLowerCase());
          if (allowed.length > 0 && !isAdmin && !allowed.includes((role || "").toLowerCase())) {
            decision = "blocked";
            reason = `Blocked by policy '${policy.name}': role '${role || "unknown"}' is not permitted to perform this action.`;
            matchedPolicyId = policy._id;
            break;
          }
        }
        if (policy.ruleType === "max_risk_level" && policy.riskLevelThreshold) {
          if (RISK_RANK[risk.riskLevel] >= RISK_RANK[policy.riskLevelThreshold]) {
            decision = "blocked";
            reason = `Blocked by policy '${policy.name}': computed risk level '${risk.riskLevel}' meets or exceeds the configured threshold '${policy.riskLevelThreshold}'.`;
            matchedPolicyId = policy._id;
            break;
          }
        }
      }
    }

    if (mongoose.connection?.readyState === 1) {
      AIGuardrailAuditModel.create({
        tenantId, branchId, userId, correlationId, toolName, decision,
        riskLevel: risk.riskLevel, riskScore: risk.riskScore, riskReasons: risk.reasons,
        policyId: matchedPolicyId, reason, promptInjectionFlagged, sensitiveFieldsDetected: sensitiveFieldsFound
      }).catch((err) => console.error("AI guardrail audit log error:", err));
    }

    publishEvent(decision === "blocked" ? "AIGuardrailBlocked" : "AIGuardrailAllowed", {
      tenantId, toolName, decision, riskLevel: risk.riskLevel, riskScore: risk.riskScore, promptInjectionFlagged
    });

    // §18 "Incident Response ... Optional Investigation" — scoped to the
    // one genuinely security-relevant case (an actual blocked manipulation
    // attempt), not routine policy/permission denials, which would just be
    // incident-log spam for ordinary admin configuration.
    if (decision === "blocked" && promptInjectionFlagged && mongoose.connection?.readyState === 1) {
      EnterpriseIncidentEngineService.createIncident({
        sourceModule: "AIGuardrail",
        category: "Security",
        type: "AI Prompt Injection Attempt Blocked",
        severity: "High",
        title: `Blocked possible prompt injection attempt on tool '${toolName}'`,
        description: reason
      }, tenantId, branchId, userId).catch((err) => console.error("AI guardrail incident creation error:", err));
    }

    return { allowed: decision === "allowed", decision, riskLevel: risk.riskLevel, riskScore: risk.riskScore, reasons: risk.reasons, reason, policyId: matchedPolicyId };
  }

  /**
   * §11 "Response Validation — Sensitive Data, Permission Leakage,
   * Hallucination Risk, Policy Compliance, Unsupported Claims." Real,
   * bounded checks that only ever REMOVE/replace content or attach an
   * advisory flag — never silently rewrite an answer's substance, since a
   * false positive there would corrupt a correct response.
   */
  static validateResponse({ finalAnswer, toolResultsText = "" }) {
    const config = getAIGuardrailConfig();
    let sanitizedAnswer = finalAnswer || "";
    let systemPromptLeakDetected = false;

    if (sanitizedAnswer.includes(config.systemPromptLeakMarker)) {
      systemPromptLeakDetected = true;
      sanitizedAnswer = "I can't share my internal instructions. How can I help with your travel request?";
    }

    const maskedAnswer = this.maskValue(sanitizedAnswer);
    const sensitiveDataMasked = maskedAnswer !== sanitizedAnswer;
    sanitizedAnswer = maskedAnswer;

    // §12 "Hallucination Prevention — Never invent ... Prices." A real,
    // bounded groundedness check: any currency-amount-shaped token in the
    // answer that doesn't appear verbatim anywhere in this turn's actual
    // tool results is surfaced as an advisory flag only — never blocked or
    // rewritten, since that risk outweighs the benefit of a heuristic this
    // simple.
    const amountPattern = /\b(?:PKR|USD|\$|₨)\s?[\d,]+(?:\.\d{1,2})?\b/gi;
    const claimedAmounts = [...sanitizedAnswer.matchAll(amountPattern)].map((m) => m[0]);
    const ungroundedClaims = [...new Set(claimedAmounts.filter((amount) => !toolResultsText.includes(amount)))];

    return { sanitizedAnswer, systemPromptLeakDetected, sensitiveDataMasked, ungroundedClaims, possiblyUngrounded: ungroundedClaims.length > 0 };
  }

  // ---- Policy CRUD (§5/§19) ----

  static async createPolicy({ tenantId, branchId = "main", userId, category, name, description, ruleType, toolName = null, allowedRoles = [], riskLevelThreshold = null }) {
    const config = getAIGuardrailConfig();
    if (!category || !config.policyCategories.includes(category)) throw new Error(`category is required and must be one of: ${config.policyCategories.join(", ")}.`);
    if (!name || !name.trim()) throw new Error("name is required.");
    if (!ruleType || !config.policyRuleTypes.includes(ruleType)) throw new Error(`ruleType is required and must be one of: ${config.policyRuleTypes.join(", ")}.`);
    if (ruleType === "max_risk_level" && !config.riskLevels.includes(riskLevelThreshold)) throw new Error(`riskLevelThreshold is required for ruleType 'max_risk_level' and must be one of: ${config.riskLevels.join(", ")}.`);
    if (ruleType === "restrict_role" && (!Array.isArray(allowedRoles) || allowedRoles.length === 0)) throw new Error("allowedRoles (a non-empty array) is required for ruleType 'restrict_role'.");

    const policy = await AIPolicyModel.create({
      tenantId, branchId, category, name: name.trim(), description: description || null,
      ruleType, toolName: toolName || null, allowedRoles: allowedRoles || [], riskLevelThreshold: riskLevelThreshold || null, createdBy: userId
    });
    publishEvent("AIPolicyCreated", { tenantId, policyId: policy._id, category, ruleType });
    return policy;
  }

  static async listPolicies({ tenantId, category, isActive, page = 1, pageSize = 20 }) {
    const safePage = Math.max(parseInt(page, 10) || 1, 1);
    const safePageSize = Math.min(Math.max(parseInt(pageSize, 10) || 20, 1), 100);
    const filter = { tenantId };
    if (category) filter.category = category;
    if (isActive !== undefined) filter.isActive = isActive === "true" || isActive === true;
    const [items, totalItems] = await Promise.all([
      AIPolicyModel.find(filter).sort({ createdAt: -1 }).skip((safePage - 1) * safePageSize).limit(safePageSize).lean(),
      AIPolicyModel.countDocuments(filter)
    ]);
    return { items, pagination: { page: safePage, pageSize: safePageSize, totalItems, totalPages: Math.ceil(totalItems / safePageSize) || 1 } };
  }

  static async updatePolicy({ tenantId, userId, policyId, updates = {} }) {
    const policy = await AIPolicyModel.findOne({ _id: policyId, tenantId });
    if (!policy) throw new Error("Policy not found.");
    const allowedFields = ["name", "description", "isActive", "allowedRoles", "riskLevelThreshold", "toolName"];
    for (const field of allowedFields) {
      if (updates[field] !== undefined) policy[field] = updates[field];
    }
    policy.updatedBy = userId;
    await policy.save();
    publishEvent("AIPolicyUpdated", { tenantId, policyId: policy._id });
    return policy;
  }

  static async deletePolicy({ tenantId, policyId }) {
    const policy = await AIPolicyModel.findOneAndDelete({ _id: policyId, tenantId });
    if (!policy) throw new Error("Policy not found.");
    publishEvent("AIPolicyDeleted", { tenantId, policyId: policy._id });
    return policy;
  }

  // ---- Audit / Monitoring (§19/§20) ----

  static async listAuditEntries({ tenantId, decision, toolName, page = 1, pageSize = 20 }) {
    const safePage = Math.max(parseInt(page, 10) || 1, 1);
    const safePageSize = Math.min(Math.max(parseInt(pageSize, 10) || 20, 1), 100);
    const filter = { tenantId };
    if (decision) filter.decision = decision;
    if (toolName) filter.toolName = toolName;
    const [items, totalItems] = await Promise.all([
      AIGuardrailAuditModel.find(filter).sort({ createdAt: -1 }).skip((safePage - 1) * safePageSize).limit(safePageSize).lean(),
      AIGuardrailAuditModel.countDocuments(filter)
    ]);
    return { items, pagination: { page: safePage, pageSize: safePageSize, totalItems, totalPages: Math.ceil(totalItems / safePageSize) || 1 } };
  }

  /**
   * §19 "Monitoring — Blocked Requests, Approval Requests, Injection
   * Attempts, Policy Violations, High Risk Requests." Real DB aggregation
   * over this tenant's own AIGuardrailAuditModel rows, mirroring
   * AIOrchestrationService.getWorkflowMetrics's own facet-aggregation
   * pattern. "Approval Requests" is deliberately not duplicated here —
   * AIOrchestrationService.getWorkflowMetrics already reports it from
   * AIApprovalRequestModel, the real source for that data.
   */
  static async getGuardrailMetrics({ tenantId }) {
    if (mongoose.connection?.readyState !== 1) {
      return { totalDecisions: 0, blockedRequests: 0, allowedRequests: 0, injectionAttempts: 0, policyViolations: 0, riskBreakdown: {} };
    }

    const [facetResult] = await AIGuardrailAuditModel.aggregate([
      { $match: { tenantId } },
      { $facet: {
        byDecision: [{ $group: { _id: "$decision", count: { $sum: 1 } } }],
        byRiskLevel: [{ $group: { _id: "$riskLevel", count: { $sum: 1 } } }],
        injectionAttempts: [{ $match: { promptInjectionFlagged: true } }, { $count: "count" }],
        policyViolations: [{ $match: { policyId: { $ne: null } } }, { $count: "count" }]
      } }
    ]);

    const decisionBreakdown = {};
    let totalDecisions = 0;
    for (const row of facetResult?.byDecision || []) { decisionBreakdown[row._id] = row.count; totalDecisions += row.count; }
    const riskBreakdown = {};
    for (const row of facetResult?.byRiskLevel || []) riskBreakdown[row._id] = row.count;

    return {
      tenantId,
      totalDecisions,
      blockedRequests: decisionBreakdown.blocked || 0,
      allowedRequests: decisionBreakdown.allowed || 0,
      injectionAttempts: facetResult?.injectionAttempts?.[0]?.count || 0,
      policyViolations: facetResult?.policyViolations?.[0]?.count || 0,
      riskBreakdown
    };
  }
}

export default AIGuardrailService;
