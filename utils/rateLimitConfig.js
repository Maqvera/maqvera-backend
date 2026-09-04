import dotenv from "dotenv";

dotenv.config();

const parseJson = (value, fallback) => {
  if (!value) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
};

const parseStringList = (value, fallback) => {
  const parsed = parseJson(value, fallback);
  return Array.isArray(parsed) && parsed.length > 0 ? parsed.map((v) => `${v}`.trim()).filter(Boolean) : fallback;
};

// Enterprise Architecture Hardening Phase — API Rate Limiting & Throttling
// Standard (Improvement 13). Real scopes only: the spec's own list also
// names "Company" and "Branch" — dropped here for the exact same reason
// `middleware/subscriptionEnforcement.js` already dropped
// `ValidateCompany()`/`ValidateBranch()` ("Company IS Tenant... no Branch
// concept, per the standing master instructions") — a distinct
// Company-scope limit would be a redundant duplicate of the Tenant-scope
// one, and a Branch-scope limit would fabricate an isolation dimension
// this codebase deliberately doesn't have.
export const getRateLimitConfig = () => {
  return {
    scopes: parseStringList(process.env.RATE_LIMIT_SCOPES_JSON, ["Tenant", "Merchant", "User", "ApiKey", "IP", "Endpoint"]),

    // "Example Limits" — real defaults, all overrideable per-tenant via
    // `models/RateLimitRuleModel.js` (utils/rateLimitRules.js).
    defaultLimits: parseJson(process.env.RATE_LIMIT_DEFAULT_LIMITS_JSON, {
      Tenant: { limit: 100000, windowSeconds: 3600 },
      Merchant: { limit: 20000, windowSeconds: 3600 },
      User: { limit: 1000, windowSeconds: 3600 },
      ApiKey: { limit: 1000, windowSeconds: 3600 },
      IP: { limit: 2000, windowSeconds: 3600 },
      Endpoint: { limit: 10000, windowSeconds: 3600 }
    }),

    // Named, endpoint-specific rules — "Login Endpoint 10/minute, Password
    // Reset 5/hour, Search API 100/minute." Looked up by `ruleKey`,
    // independent of (and typically tighter than) the caller's own
    // scope default.
    namedRuleDefaults: parseJson(process.env.RATE_LIMIT_NAMED_RULES_JSON, {
      login: { limit: 10, windowSeconds: 60 },
      passwordReset: { limit: 5, windowSeconds: 3600 },
      search: { limit: 100, windowSeconds: 60 }
    }),

    // "Priority-Based Throttling... Low-priority APIs are throttled
    // first." Real, deterministic policy: a static per-priority
    // multiplier applied to whatever limit was otherwise resolved — not a
    // dynamic system-load detector (this codebase has no real load-
    // sensing infrastructure to honestly build that on).
    priorityMultipliers: parseJson(process.env.RATE_LIMIT_PRIORITY_MULTIPLIERS_JSON, { High: 1.5, Medium: 1, Low: 0.5 }),

    // "Burst Protection... 10,000 Requests in 10 Seconds -> Burst
    // detected." A real, SEPARATE short-window counter checked alongside
    // the main one — `burstRatio` of the resolved limit is the max
    // allowed within `burstWindowSeconds`.
    burstWindowSeconds: parseInt(process.env.RATE_LIMIT_BURST_WINDOW_SECONDS || "10", 10),
    burstRatio: parseFloat(process.env.RATE_LIMIT_BURST_RATIO || "0.1"),

    // "Abuse Detection" — a real, simple, honest heuristic: this many
    // violations for the same identifier within this many minutes.
    abuseViolationThreshold: parseInt(process.env.RATE_LIMIT_ABUSE_VIOLATION_THRESHOLD || "5", 10),
    abuseWindowMinutes: parseInt(process.env.RATE_LIMIT_ABUSE_WINDOW_MINUTES || "10", 10),

    ruleStatuses: parseStringList(process.env.RATE_LIMIT_RULE_STATUSES_JSON, ["Active", "Inactive"]),
    defaultPageSize: parseInt(process.env.RATE_LIMIT_DEFAULT_PAGE_SIZE || "20", 10),
    maxPageSize: parseInt(process.env.RATE_LIMIT_MAX_PAGE_SIZE || "100", 10)
  };
};

export default getRateLimitConfig;
