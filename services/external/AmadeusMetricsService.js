/**
 * AmadeusMetricsService — EXT-002 §16. In-memory, per-process counters
 * (same honesty scope as GdsIntegrationService's CircuitBreaker state:
 * real, live numbers for this running instance, not a claim of persisted
 * cross-restart/cross-instance metrics — that would need a real metrics
 * backend, which isn't part of this document's scope).
 */
class AmadeusMetricsService {
  static counters = {
    searchCount: 0,
    totalResponseTimeMs: 0,
    responseCount: 0,
    providerCalls: 0,
    providerFailures: 0,
    timeoutCount: 0,
    failedSearchCount: 0,
    cacheHits: 0,
    cacheMisses: 0,
    rateLimitedCount: 0,
    oauthRefreshCount: 0
  };

  static recordSearch(durationMs, succeeded) {
    this.counters.searchCount += 1;
    this.counters.totalResponseTimeMs += durationMs;
    this.counters.responseCount += 1;
    if (!succeeded) this.counters.failedSearchCount += 1;
  }

  static recordProviderCall() { this.counters.providerCalls += 1; }
  static recordProviderFailure() { this.counters.providerFailures += 1; }
  static recordTimeout() { this.counters.timeoutCount += 1; }
  static recordRateLimited() { this.counters.rateLimitedCount += 1; }
  static recordCacheHit() { this.counters.cacheHits += 1; }
  static recordCacheMiss() { this.counters.cacheMisses += 1; }
  static recordOAuthRefresh() { this.counters.oauthRefreshCount += 1; }

  static getSnapshot() {
    const c = this.counters;
    const totalCacheLookups = c.cacheHits + c.cacheMisses;
    return {
      searchCount: c.searchCount,
      averageResponseTimeMs: c.responseCount > 0 ? Number((c.totalResponseTimeMs / c.responseCount).toFixed(1)) : 0,
      providerAvailabilityPct: c.providerCalls > 0 ? Number((((c.providerCalls - c.providerFailures) / c.providerCalls) * 100).toFixed(2)) : 100,
      timeoutRatePct: c.providerCalls > 0 ? Number(((c.timeoutCount / c.providerCalls) * 100).toFixed(2)) : 0,
      failedSearches: c.failedSearchCount,
      cacheHitRatePct: totalCacheLookups > 0 ? Number(((c.cacheHits / totalCacheLookups) * 100).toFixed(2)) : 0,
      oauthRefreshCount: c.oauthRefreshCount,
      rateLimitedCount: c.rateLimitedCount,
      since: this.startedAt
    };
  }

  static startedAt = new Date().toISOString();
}

export default AmadeusMetricsService;
