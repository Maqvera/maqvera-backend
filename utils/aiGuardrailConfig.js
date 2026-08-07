import dotenv from "dotenv";
dotenv.config();

const parseNumber = (value, fallback) => {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const parseJsonArray = (value, fallback) => {
  if (!value) return fallback;
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : fallback;
  } catch {
    return fallback;
  }
};

const parseJsonObject = (value, fallback) => {
  if (!value) return fallback;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : fallback;
  } catch {
    return fallback;
  }
};

/**
 * EXT-032 "AI Safety, Guardrails & Policy Enforcement" configuration.
 * Config-driven per this codebase's own convention (CLAUDE.md
 * "Config-driven domain values").
 */
export const getAIGuardrailConfig = () => ({
  // §5 "Policy Categories" — real, tenant-configurable AIPolicyModel rows
  // are validated against this list.
  policyCategories: parseJsonArray(process.env.AI_GUARDRAIL_POLICY_CATEGORIES_JSON, ["Security", "Business", "Travel", "Finance", "Privacy", "Compliance", "AI", "Custom"]),
  // Only these three are genuinely, immediately enforceable against the
  // real tool catalog today: `require_approval` is deliberately excluded —
  // every non-read tool in AIToolRegistry already requires approval, so a
  // policy type promising to dynamically wrap an arbitrary tool in an
  // approval flow it doesn't support would be a half-built feature, not a
  // real one.
  policyRuleTypes: ["block_tool", "restrict_role", "max_risk_level"],
  riskLevels: ["low", "medium", "high", "critical"],

  // §14 "Risk Levels" — real, computed per request (see
  // AIGuardrailService.assessRisk), not a static per-tool label. Base score
  // keyed by the tool's own static `riskLevel` classification
  // ("read"/"high" today; "medium"/"critical" reserved for future tools),
  // then adjusted by real signals observed on THIS request.
  riskBaseScoreByToolRiskLevel: parseJsonObject(process.env.AI_GUARDRAIL_RISK_BASE_SCORE_JSON, { read: 5, medium: 35, high: 55, critical: 80 }),
  riskScoreForInjectionFlag: parseNumber(process.env.AI_GUARDRAIL_RISK_SCORE_INJECTION, 30),
  riskScoreForSensitiveField: parseNumber(process.env.AI_GUARDRAIL_RISK_SCORE_SENSITIVE_FIELD, 15),
  riskThresholds: parseJsonObject(process.env.AI_GUARDRAIL_RISK_THRESHOLDS_JSON, { medium: 25, high: 55, critical: 80 }),

  // §9 "Prompt Injection Protection" — a real, bounded heuristic (regex
  // phrase list), not a claim of foolproof detection. Centralized here as
  // the single source of truth; AIAssistantService's own detector now
  // delegates to this.
  promptInjectionPatterns: parseJsonArray(process.env.AI_GUARDRAIL_PROMPT_INJECTION_PATTERNS_JSON, [
    "ignore (all )?(previous|prior|above) instructions",
    "disregard (all )?(previous|prior|above) instructions",
    "you are now",
    "system prompt",
    "reveal your (instructions|prompt|system message)",
    "act as (if )?(you (are|were) )?(an? )?(unrestricted|jailbroken|dan)"
  ]),
  // §9 "Prompt injection detected before execution" — real defense-in-depth:
  // a turn flagged for injection can never trigger a non-read (write-
  // capable / approval-creating) tool, regardless of tenant policy
  // configuration. Read-only tools (search/explain/recommend) are still
  // allowed — blocking those too would make the assistant unusable on any
  // false-positive match, for no real security benefit since reads can't
  // mutate anything.
  blockNonReadToolsOnInjection: (process.env.AI_GUARDRAIL_BLOCK_NON_READ_ON_INJECTION ?? "true") !== "false",

  // §8 "Sensitive Data Protection" — field-NAME based detection (matched
  // case-insensitively as a substring against tool argument keys) is the
  // primary, reliable signal; free-text VALUE patterns below are a
  // secondary, best-effort scan over string content (e.g. the model's own
  // final answer) where there is no key name to go by. Both are bounded
  // heuristics, not a claim of exhaustive PII detection.
  sensitiveFieldNamePatterns: parseJsonArray(process.env.AI_GUARDRAIL_SENSITIVE_FIELD_NAME_PATTERNS_JSON, [
    "passport", "nationalId", "national_id", "cnic", "ssn", "socialSecurity",
    "creditCard", "credit_card", "cardNumber", "cvv", "bankAccount", "bank_account", "iban",
    "medicalInfo", "medicalCondition", "diagnosis", "visaDocument", "personalNote",
    "authToken", "accessToken", "refreshToken", "apiKey", "secret", "password"
  ]),
  sensitiveValuePatterns: parseJsonArray(process.env.AI_GUARDRAIL_SENSITIVE_VALUE_PATTERNS_JSON, [
    "\\b\\d{4}[ -]?\\d{4}[ -]?\\d{4}[ -]?\\d{4}\\b",
    "\\b\\d{5}-\\d{7}-\\d{1}\\b",
    "\\b[A-Z]{2}\\d{2}[A-Z0-9]{10,30}\\b"
  ]),

  // §11 "Response Validation" — the exact marker the relocated default
  // system prompt (utils/aiPromptDefaults.js) contains; a leaked system
  // prompt would echo it back verbatim.
  systemPromptLeakMarker: process.env.AI_GUARDRAIL_SYSTEM_PROMPT_LEAK_MARKER || "RULES YOU MUST FOLLOW",

  // §19 "Only authorized administrators may manage policies."
  managePermission: process.env.AI_GUARDRAIL_MANAGE_PERMISSION || "ai.guardrail.manage"
});

export default getAIGuardrailConfig;
