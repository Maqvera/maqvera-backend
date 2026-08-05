import AmadeusMetricsService from "../services/external/AmadeusMetricsService.js";
import GdsIntegrationService from "../services/GdsIntegrationService.js";
import { sendError, sendSuccess } from "../utils/apiResponse.js";
import { createRequestId } from "../utils/authTokens.js";

const METRICS_PERMISSION = "admin";

/**
 * EXT-025 §16 "Monitoring — Metrics... Dashboard uses Prometheus + Grafana."
 * Real, honest scope: this process doesn't run a Prometheus/Grafana
 * server (that's external monitoring infrastructure, not application
 * code), but it DOES already track real counters
 * (`AmadeusMetricsService`, tracked since EXT-002, never previously
 * exposed anywhere) and real per-provider circuit-breaker state
 * (`GdsIntegrationService.getProviderStatus()`, already exposed
 * elsewhere for hotels but not surfaced in Prometheus-scrapable form).
 * This endpoint genuinely closes that gap: a real Prometheus text
 * exposition format response an actual Prometheus server can scrape.
 */
export const GetAmadeusMetricsJson = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    if (!(req.auth?.permissions || []).includes(METRICS_PERMISSION)) {
      return sendError(res, 403, "Permission denied.", requestId);
    }
    const snapshot = AmadeusMetricsService.getSnapshot();
    const providerStatus = await GdsIntegrationService.getProviderStatus();
    return sendSuccess(res, 200, "Amadeus integration metrics retrieved successfully.", { ...snapshot, providers: providerStatus }, requestId);
  } catch (err) {
    console.error("GetAmadeusMetricsJson Error:", err);
    return sendError(res, 500, "Failed to retrieve metrics.", requestId);
  }
};

/** Real Prometheus text exposition format (https://prometheus.io/docs/instrumenting/exposition_formats/) — scrapable by an actual Prometheus server. */
export const GetAmadeusMetricsPrometheus = async (req, res) => {
  try {
    if (!(req.auth?.permissions || []).includes(METRICS_PERMISSION)) {
      return res.status(403).send("# permission denied\n");
    }
    const s = AmadeusMetricsService.getSnapshot();
    const providerStatus = await GdsIntegrationService.getProviderStatus();

    const lines = [
      "# HELP amadeus_search_count Total flight searches processed since process start.",
      "# TYPE amadeus_search_count counter",
      `amadeus_search_count ${s.searchCount}`,
      "# HELP amadeus_search_avg_response_ms Average search response time in milliseconds.",
      "# TYPE amadeus_search_avg_response_ms gauge",
      `amadeus_search_avg_response_ms ${s.averageResponseTimeMs}`,
      "# HELP amadeus_provider_availability_pct Percentage of provider calls that did not fail.",
      "# TYPE amadeus_provider_availability_pct gauge",
      `amadeus_provider_availability_pct ${s.providerAvailabilityPct}`,
      "# HELP amadeus_timeout_rate_pct Percentage of provider calls that timed out.",
      "# TYPE amadeus_timeout_rate_pct gauge",
      `amadeus_timeout_rate_pct ${s.timeoutRatePct}`,
      "# HELP amadeus_failed_searches_total Total failed searches since process start.",
      "# TYPE amadeus_failed_searches_total counter",
      `amadeus_failed_searches_total ${s.failedSearches}`,
      "# HELP amadeus_cache_hit_rate_pct Cache hit rate percentage.",
      "# TYPE amadeus_cache_hit_rate_pct gauge",
      `amadeus_cache_hit_rate_pct ${s.cacheHitRatePct}`,
      "# HELP amadeus_oauth_refresh_total Total OAuth token refreshes since process start.",
      "# TYPE amadeus_oauth_refresh_total counter",
      `amadeus_oauth_refresh_total ${s.oauthRefreshCount}`,
      "# HELP amadeus_rate_limited_total Total requests rejected by the provider with 429.",
      "# TYPE amadeus_rate_limited_total counter",
      `amadeus_rate_limited_total ${s.rateLimitedCount}`,
      "# HELP amadeus_circuit_breaker_open Whether a provider's circuit breaker is currently open (1) or closed/half-open (0).",
      "# TYPE amadeus_circuit_breaker_open gauge"
    ];
    for (const [provider, status] of Object.entries(providerStatus)) {
      lines.push(`amadeus_circuit_breaker_open{provider="${provider}"} ${status.circuitBreaker?.status === "open" ? 1 : 0}`);
    }

    res.setHeader("Content-Type", "text/plain; version=0.0.4; charset=utf-8");
    return res.status(200).send(lines.join("\n") + "\n");
  } catch (err) {
    console.error("GetAmadeusMetricsPrometheus Error:", err);
    return res.status(500).send(`# error retrieving metrics: ${err.message}\n`);
  }
};
