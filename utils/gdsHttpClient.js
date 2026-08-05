import dotenv from "dotenv";
import { getFlightSearchValidationConfig, getAmadeusHttpPolicy } from "./gdsConfig.js";
import CacheManager from "./cacheManager.js";
import { publishEvent } from "./eventBus.js";
import AmadeusMetricsService from "../services/external/AmadeusMetricsService.js";
dotenv.config();

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Enterprise Production GDS HTTP Client & Authentication Manager
 * Handles OAuth2 bearer token acquisition, header injection, live HTTP network calls,
 * and fallback sandbox generation for Amadeus, Sabre, and Hotelbeds.
 */
class GdsHttpClient {
  /**
   * Get OAuth2 Bearer Token for Amadeus REST API — EXT-002 §12 "Access
   * Token → Redis Cache → Automatic Refresh". Was previously an in-memory
   * `Map`, meaning every server instance (and every restart) re-authenticated
   * from scratch; now goes through the same CacheManager (Redis when
   * configured, in-memory fallback otherwise) every other cached value in
   * this codebase uses, so the token is genuinely shared/persisted where Redis
   * is available.
   */
  async getAmadeusToken() {
    const clientId = process.env.AMADEUS_CLIENT_ID;
    const clientSecret = process.env.AMADEUS_CLIENT_SECRET;
    const baseUrl = process.env.AMADEUS_BASE_URL || process.env.GDS_BASE_URL || "https://test.api.amadeus.com";

    if (!clientId || clientId.includes("YOUR_") || !clientSecret || clientSecret.includes("YOUR_")) {
      return null;
    }

    const cacheKey = `gds:amadeus-token:${clientId}`;
    const cachedToken = await CacheManager.get(cacheKey);
    if (cachedToken) {
      return cachedToken;
    }

    try {
      const { requestTimeoutMs } = getFlightSearchValidationConfig();
      const response = await fetch(`${baseUrl}/v1/security/oauth2/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "client_credentials",
          client_id: clientId,
          client_secret: clientSecret
        }),
        signal: AbortSignal.timeout(requestTimeoutMs)
      });

      if (!response.ok) {
        console.warn(`[GDS Client] Amadeus Auth failed with status ${response.status}`);
        return null;
      }

      const data = await response.json();
      // Refresh a little before actual expiry so a request never races an
      // about-to-expire token.
      const ttlSeconds = Math.max(60, (data.expires_in || 1800) - 60);
      await CacheManager.set(cacheKey, data.access_token, ttlSeconds);
      AmadeusMetricsService.recordOAuthRefresh();
      return data.access_token;
    } catch (err) {
      console.warn(`[GDS Client] Amadeus Token Fetch error: ${err.message}`);
      return null;
    }
  }

  /**
   * Executive HTTP Request to Amadeus REST API — EXT-002 §14 real
   * exponential-backoff retry, with 429 (rate limit) detected and reported
   * distinctly from other failures, and §16 metrics/timing capture.
   *
   * `options.timeoutMs`/`options.maxRetriesOverride` let a caller apply a
   * distinct policy (e.g. EXT-003's "Timeout 30 Seconds / Retry Once" for
   * pricing) without changing the default policy every other caller relies
   * on. `options.throwOnError` is opt-in and defaults to false, so every
   * EXISTING caller (search, token) keeps its exact current behavior
   * (return null on any failure → triggers the dynamic-sandbox fallback);
   * only a caller that explicitly needs to distinguish "no live
   * credentials" from "the provider said no" (like pricing, where that
   * distinction is the difference between a fabricated price and a real
   * PRICE_CHANGED/FLIGHT_NOT_AVAILABLE error) opts in.
   */
  async requestAmadeus(endpoint, method = "GET", body = null, options = {}) {
    const { timeoutMs: timeoutOverrideMs, maxRetriesOverride, throwOnError = false } = options;
    const baseUrl = process.env.AMADEUS_BASE_URL || process.env.GDS_BASE_URL || "https://test.api.amadeus.com";
    const token = await this.getAmadeusToken();

    if (!token) {
      return null; // Triggers dynamic sandbox generator
    }

    const requestTimeoutMs = timeoutOverrideMs || getFlightSearchValidationConfig().requestTimeoutMs;
    const policy = getAmadeusHttpPolicy();
    const maxRetries = maxRetriesOverride != null ? maxRetriesOverride : policy.maxRetries;
    const backoffBaseMs = policy.backoffBaseMs;
    const fetchOptions = {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json"
      }
    };
    if (body && method !== "GET") {
      fetchOptions.body = JSON.stringify(body);
    }

    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      publishEvent("ProviderCalled", { provider: "Amadeus", endpoint, attempt });
      AmadeusMetricsService.recordProviderCall();
      const startedAt = Date.now();

      try {
        const res = await fetch(`${baseUrl}${endpoint}`, { ...fetchOptions, signal: AbortSignal.timeout(requestTimeoutMs) });
        const latencyMs = Date.now() - startedAt;

        if (res.status === 429) {
          AmadeusMetricsService.recordRateLimited();
          publishEvent("ProviderRateLimited", { provider: "Amadeus", endpoint, attempt, latencyMs });
          console.warn(`[GDS Client] Amadeus rate-limited (429) for ${endpoint}, attempt ${attempt + 1}/${maxRetries + 1}`);
          if (attempt < maxRetries) {
            await sleep(backoffBaseMs * 2 ** attempt);
            continue;
          }
          AmadeusMetricsService.recordProviderFailure();
          if (throwOnError) {
            const err = new Error(`Amadeus rate-limited this request (429) for ${endpoint}.`);
            err.status = 429;
            throw err;
          }
          return null;
        }

        if (!res.ok) {
          console.warn(`[GDS Client] Amadeus API returned ${res.status} for ${endpoint}`);
          AmadeusMetricsService.recordProviderFailure();
          if (throwOnError) {
            const err = new Error(`Amadeus API returned ${res.status} for ${endpoint}.`);
            err.status = res.status;
            err.body = await res.json().catch(() => null);
            throw err;
          }
          return null;
        }

        return await res.json();
      } catch (err) {
        if (err.status) throw err; // already a structured provider error from above, don't retry-swallow it
        const isTimeout = err.name === "TimeoutError" || err.name === "AbortError";
        if (isTimeout) {
          AmadeusMetricsService.recordTimeout();
          publishEvent("ProviderTimeout", { provider: "Amadeus", endpoint, attempt });
        }
        console.warn(`[GDS Client] ${isTimeout ? "Timeout" : "Network error"} calling Amadeus (${endpoint}): ${err.message}`);
        if (attempt < maxRetries) {
          await sleep(backoffBaseMs * 2 ** attempt);
          continue;
        }
        AmadeusMetricsService.recordProviderFailure();
        if (throwOnError) {
          const wrapped = new Error(isTimeout ? `Amadeus request timed out for ${endpoint}.` : `Network error calling Amadeus (${endpoint}): ${err.message}`);
          wrapped.status = isTimeout ? 504 : 502;
          throw wrapped;
        }
        return null;
      }
    }

    return null;
  }
}

export default new GdsHttpClient();
