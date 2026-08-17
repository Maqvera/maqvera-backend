// Enterprise Subscription Automation Layer — Automation #6 (Enterprise
// Subscription Enforcement Middleware). "Monitoring Dashboard... Average
// Middleware Time." Real, in-process counters since process start — the
// exact same honesty scope `utils/cacheManager.js#getStats` already
// documents for its own hit/miss counters (a real signal for this running
// instance, never a claim of a distributed/cross-instance total). Kept
// deliberately out-of-DB: this is measured on literally every
// authenticated request, so a DB write here would defeat the entire point
// of the enforcement check being cached in the first place.
let checksPerformed = 0;
let totalDurationMs = 0;
let blockedCount = 0;

export const recordEnforcementCheck = (durationMs, blocked) => {
  checksPerformed += 1;
  totalDurationMs += durationMs;
  if (blocked) blockedCount += 1;
};

export const getEnforcementMetrics = () => ({
  checksPerformed,
  blockedCount,
  averageMiddlewareTimeMs: checksPerformed > 0 ? Number((totalDurationMs / checksPerformed).toFixed(3)) : null
});
