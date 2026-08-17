import { getAccessScope } from "../utils/accessScope.js";
import { resolveLimit, checkRateLimit, checkBurst, resolveMerchantAccountId } from "../utils/rateLimiter.js";
import { AppError, sendStandardError } from "../utils/errorContract.js";

/**
 * Enterprise API Rate Limiting & Throttling Standard (Enterprise
 * Architecture Hardening Phase, Improvement 13). Real, distributed
 * (MongoDB-shared, Improvement 6's own "single source of truth across
 * every node" discipline) rate limiting — scoped beyond the pure-IP
 * limiting `express-rate-limit` already provides on ~30 routes throughout
 * this codebase (which stays untouched; this is a NEW, additive
 * middleware, not a replacement).
 *
 * `router.use(enterpriseRateLimit({ scope: "Tenant" }))` or, for a named
 * rule, `router.post("/login", enterpriseRateLimit({ scope: "IP", ruleKey: "login" }), ...)`.
 * Not mounted on any existing route in this pass — see
 * docs/07-enterprise-standards/13-rate-limiting.md "Adoption".
 */
const resolveIdentifier = async (req, scope) => {
  const scopeValue = getAccessScope(req);
  switch (scope) {
    case "Tenant":
      return scopeValue?.tenantId || null;
    case "User":
      return req.auth?.userId || req.auth?.id || null;
    case "Merchant":
      return scopeValue?.tenantId ? await resolveMerchantAccountId(scopeValue.tenantId) : null;
    case "ApiKey":
      return req.header("X-Api-Key") || null;
    case "IP":
      return req.ip || req.socket?.remoteAddress || null;
    case "Endpoint":
      return `${req.method} ${req.baseUrl}${req.path}`;
    default:
      return null;
  }
};

export const enterpriseRateLimit = ({ scope, ruleKey = null, priority = "Medium" }) => async (req, res, next) => {
  try {
    const identifier = await resolveIdentifier(req, scope);
    if (!identifier) return next(); // scope's identity isn't resolvable for this request -> fail open, never block on a missing dimension

    const tenantId = getAccessScope(req)?.tenantId || null;
    const correlationId = req.requestId || null;
    const requestPath = `${req.method} ${req.originalUrl}`;

    const { limit, windowSeconds } = await resolveLimit({ tenantId, scope, ruleKey, priority });
    await checkBurst({ scope, identifier, mainLimit: limit, tenantId, correlationId });
    const result = await checkRateLimit({ scope, ruleKey, identifier, limit, windowSeconds, tenantId, correlationId, requestPath });

    res.setHeader("X-RateLimit-Limit", result.limit);
    res.setHeader("X-RateLimit-Remaining", result.remaining);
    res.setHeader("X-RateLimit-Reset", Math.floor(result.resetAt.getTime() / 1000));

    if (!result.allowed) {
      const retryAfter = Math.max(Math.ceil((result.resetAt.getTime() - Date.now()) / 1000), 1);
      res.setHeader("Retry-After", retryAfter);
      return sendStandardError(res, new AppError("RATE_LIMITED", { message: "Request limit exceeded.", details: { retryAfter, scope, limit } }), correlationId);
    }

    next();
  } catch (error) {
    // Fail open — an availability bug in this platform must never itself
    // become a reason a real business request is blocked (same
    // discipline as middleware/subscriptionEnforcement.js and
    // middleware/idempotency.js).
    next();
  }
};

export default enterpriseRateLimit;
