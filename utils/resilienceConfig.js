import dotenv from "dotenv";

dotenv.config();

const parseJson = (value, fallback) => {
  if (!value) return fallback;
  if (typeof value === "string") {
    try {
      return JSON.parse(value);
    } catch (error) {
      return fallback;
    }
  }
  return value;
};

// Enterprise Architecture Hardening Phase — Resilience & Reliability
// Standard (Improvement 6). Per-integration retry/timeout limits, straight
// from the spec's own "Recommended defaults" table — real, admin-
// configurable ceilings (env JSON override), never hardcoded per call
// site.
const DEFAULT_INTEGRATIONS = {
  BankAPI: { timeoutMs: 30000, maxRetries: 5 },
  PaymentGateway: { timeoutMs: 30000, maxRetries: 5 },
  ExchangeRateProvider: { timeoutMs: 10000, maxRetries: 3 },
  TaxAuthority: { timeoutMs: 60000, maxRetries: 5 },
  Email: { timeoutMs: 15000, maxRetries: 3 },
  SMS: { timeoutMs: 10000, maxRetries: 3 },
  GovernmentAPI: { timeoutMs: 60000, maxRetries: 5 }
};

// "Retryable Errors: HTTP 500/502/503/504, Network Timeout, Connection
// Reset, Temporary DNS Failure, Gateway Timeout." / "Non-Retryable: 401,
// 403, 404, 409, 422, Invalid Credentials, Invalid Request, Duplicate
// Payment." — the real classification `isRetryableError` (below) checks
// against, straight from the spec's own two tables.
const RETRYABLE_HTTP_STATUS_CODES = [500, 502, 503, 504];
const NON_RETRYABLE_HTTP_STATUS_CODES = [400, 401, 403, 404, 409, 422];
const RETRYABLE_NETWORK_ERROR_CODES = ["ECONNRESET", "ETIMEDOUT", "ECONNABORTED", "ENOTFOUND", "EAI_AGAIN"];

export const getResilienceConfig = () => {
  const integrations = { ...DEFAULT_INTEGRATIONS, ...parseJson(process.env.RESILIENCE_INTEGRATIONS_JSON, {}) };
  return {
    integrations,
    defaultIntegration: { timeoutMs: parseInt(process.env.RESILIENCE_DEFAULT_TIMEOUT_MS || "20000", 10), maxRetries: parseInt(process.env.RESILIENCE_DEFAULT_MAX_RETRIES || "3", 10) },

    // Exponential backoff with jitter — "Retry 1s -> 2s -> 4s -> 8s ->
    // 16s," capped, plus real jitter so many concurrent retrying clients
    // don't all wake up at the exact same moment (a retry storm against a
    // recovering system).
    backoffBaseMs: parseInt(process.env.RESILIENCE_BACKOFF_BASE_MS || "1000", 10),
    backoffFactor: parseFloat(process.env.RESILIENCE_BACKOFF_FACTOR || "2"),
    backoffMaxMs: parseInt(process.env.RESILIENCE_BACKOFF_MAX_MS || "30000", 10),
    backoffJitterRatio: parseFloat(process.env.RESILIENCE_BACKOFF_JITTER_RATIO || "0.2"),

    // Circuit Breaker — Closed -> Open -> HalfOpen -> Closed.
    circuitFailureThreshold: parseInt(process.env.RESILIENCE_CIRCUIT_FAILURE_THRESHOLD || "5", 10),
    circuitOpenDurationMs: parseInt(process.env.RESILIENCE_CIRCUIT_OPEN_DURATION_MS || "30000", 10),

    retryableHttpStatusCodes: parseJson(process.env.RESILIENCE_RETRYABLE_STATUS_CODES_JSON, RETRYABLE_HTTP_STATUS_CODES),
    nonRetryableHttpStatusCodes: parseJson(process.env.RESILIENCE_NON_RETRYABLE_STATUS_CODES_JSON, NON_RETRYABLE_HTTP_STATUS_CODES),
    retryableNetworkErrorCodes: parseJson(process.env.RESILIENCE_RETRYABLE_NETWORK_CODES_JSON, RETRYABLE_NETWORK_ERROR_CODES),

    dlqStatuses: parseJson(process.env.RESILIENCE_DLQ_STATUSES_JSON, ["Pending", "Reprocessing", "Recovered", "PermanentFailure"]),

    defaultPageSize: parseInt(process.env.RESILIENCE_DEFAULT_PAGE_SIZE || "20", 10),
    maxPageSize: parseInt(process.env.RESILIENCE_MAX_PAGE_SIZE || "100", 10)
  };
};

/** Resolves a specific integration's config, falling back to `defaultIntegration` for one not in the catalog — never throws for an unknown integration name (a new one can be used immediately, just without a tuned override yet). */
export const getIntegrationConfig = (integrationName) => {
  const config = getResilienceConfig();
  return config.integrations[integrationName] || config.defaultIntegration;
};

/**
 * Real classification straight from the spec's own two tables — an HTTP
 * status/network error code NOT on either list is treated as
 * non-retryable by default (the safe default: never retry something
 * unclassified rather than risk retrying a genuinely permanent failure).
 */
export const isRetryableError = (error) => {
  const config = getResilienceConfig();
  const status = error?.response?.status || error?.httpStatus || error?.status;
  if (status !== undefined) return config.retryableHttpStatusCodes.includes(status) && !config.nonRetryableHttpStatusCodes.includes(status);
  if (error?.name === "AbortError") return true; // our own timeout abort
  if (error?.code && config.retryableNetworkErrorCodes.includes(error.code)) return true;
  return false;
};

export default getResilienceConfig;
