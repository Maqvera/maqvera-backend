import dotenv from "dotenv";
dotenv.config();

const parseNumber = (value, fallback) => {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : fallback;
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
 * EXT-033 "AI Observability, Monitoring & Evaluation" configuration.
 * Config-driven per this codebase's own convention (CLAUDE.md
 * "Config-driven domain values").
 */
export const getAIObservabilityConfig = () => ({
  // §15 "Error Categories" — a bounded, honest classifier (same style as
  // AIOrchestrationService's own existing isRetryableError pattern-match),
  // not a claim of perfect categorization. Checked in order; first match
  // wins.
  errorCategoryPatterns: parseJsonObject(process.env.AI_OBSERVABILITY_ERROR_CATEGORY_PATTERNS_JSON, {
    policy_violation: "blocked by ai safety policy|blocked:|blocked by policy",
    permission_error: "permission denied",
    timeout: "timed out",
    provider_error: "no configured provider|could not be reached|ai service is not available",
    workflow_error: "not found and cannot|already .* and cannot|dependency step",
    tool_error: "rate limit exceeded|unknown tool",
    llm_error: "ai_unavailable|the ai planner did not return"
  }),

  // §22 "AI Health Score — Calculated From Availability/Accuracy/Latency/
  // Failures/Safety/Quality/Tool Success." Weights sum to 1.0; each
  // sub-score is itself a real 0-100 number derived from actual metrics,
  // never fabricated — see AIObservabilityService.getHealthScore.
  healthScoreWeights: parseJsonObject(process.env.AI_OBSERVABILITY_HEALTH_WEIGHTS_JSON, {
    availability: 0.2, latency: 0.15, failures: 0.2, safety: 0.15, quality: 0.15, toolSuccess: 0.15
  }),
  // A request slower than this scores 0 on the latency sub-score; faster
  // than "good" scores 100; linear in between.
  latencyGoodMs: parseNumber(process.env.AI_OBSERVABILITY_LATENCY_GOOD_MS, 3000),
  latencyPoorMs: parseNumber(process.env.AI_OBSERVABILITY_LATENCY_POOR_MS, 15000),

  // §19 "Alerting" thresholds — each is a real, configurable trigger point;
  // exceeding it (over the evaluation window) opens/keeps-open an
  // AIAlertModel row, dropping back below it resolves that row.
  alertThresholds: parseJsonObject(process.env.AI_OBSERVABILITY_ALERT_THRESHOLDS_JSON, {
    failureRatePct: 25, // "High latency" / "Tool failures" style — request failure rate over the window
    highLatencyMs: 10000,
    hallucinationRatePct: 15, // share of answers with a possiblyUngroundedClaims flag
    toolFailureRatePct: 30,
    dailyCostUsd: 25,
    guardrailBlockRatePct: 20,
    providerUnavailable: true // boolean toggle — alert whenever neither configured LLM provider is reachable
  }),
  alertEvaluationWindowMs: parseNumber(process.env.AI_OBSERVABILITY_ALERT_WINDOW_MS, 60 * 60 * 1000),
  // A window with fewer than this many requests is too thin to judge a
  // rate-based threshold (e.g. 1 failure out of 1 request is not a "25%
  // failure rate" incident) — the alert simply isn't evaluated that sweep.
  alertMinSampleSize: parseNumber(process.env.AI_OBSERVABILITY_ALERT_MIN_SAMPLE, 5),
  sweepCronSchedule: process.env.AI_OBSERVABILITY_ALERT_CRON_SCHEDULE || "*/10 * * * *",

  // How far back "recent activity" reaches when discovering which tenants
  // to evaluate alerts for, and the default lookback for dashboard queries
  // that don't specify an explicit from/to range.
  defaultLookbackMs: parseNumber(process.env.AI_OBSERVABILITY_DEFAULT_LOOKBACK_MS, 24 * 60 * 60 * 1000),

  managePermission: process.env.AI_OBSERVABILITY_MANAGE_PERMISSION || "ai.observability.manage"
});

export default getAIObservabilityConfig;
