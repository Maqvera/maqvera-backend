import { getAIConfig } from "../../utils/aiConfig.js";

const WINDOW_MS = 60000; // fixed 1-minute window, matching the "PerMinute" config naming.

/**
 * EXT-026 §13 "Rate Limiting" — real, in-process fixed-window counters per
 * (user, tool), (tenant, tool), and (tool) globally. Same honesty scope as
 * GdsIntegrationService's own CircuitBreaker: real and enforced for this
 * running instance, not a claim of a distributed/cross-instance guarantee
 * (that would need a shared store like Redis, which this codebase's
 * CacheManager could back later without changing this class's interface).
 */
class AIToolRateLimiter {
  static _windows = new Map(); // key -> { count, windowStart }

  static _checkAndIncrement(key, limit) {
    const now = Date.now();
    const entry = AIToolRateLimiter._windows.get(key);
    if (!entry || now - entry.windowStart >= WINDOW_MS) {
      AIToolRateLimiter._windows.set(key, { count: 1, windowStart: now });
      return { allowed: true };
    }
    if (entry.count >= limit) {
      return { allowed: false, retryAfterMs: WINDOW_MS - (now - entry.windowStart) };
    }
    entry.count += 1;
    return { allowed: true };
  }

  /** Checked before every tool execution, at three independent scopes — user, tenant, then global. */
  static check({ tenantId, userId, toolName }) {
    const config = getAIConfig();

    const userResult = AIToolRateLimiter._checkAndIncrement(`user:${tenantId}:${userId}:${toolName}`, config.toolRateLimitPerUserPerMinute);
    if (!userResult.allowed) return { allowed: false, scope: "user", retryAfterMs: userResult.retryAfterMs };

    const tenantResult = AIToolRateLimiter._checkAndIncrement(`tenant:${tenantId}:${toolName}`, config.toolRateLimitPerTenantPerMinute);
    if (!tenantResult.allowed) return { allowed: false, scope: "tenant", retryAfterMs: tenantResult.retryAfterMs };

    const globalResult = AIToolRateLimiter._checkAndIncrement(`global:${toolName}`, config.toolRateLimitGlobalPerMinute);
    if (!globalResult.allowed) return { allowed: false, scope: "global", retryAfterMs: globalResult.retryAfterMs };

    return { allowed: true };
  }
}

export default AIToolRateLimiter;
