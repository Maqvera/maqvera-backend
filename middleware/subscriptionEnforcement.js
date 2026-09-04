import TenantSubscriptionService from "../services/TenantSubscriptionService.js";
import { sendError } from "../utils/apiResponse.js";
import { getAccessScope } from "../utils/accessScope.js";

// Enterprise Subscription Platform — "Refactor Pattern 1 (Apply To EVERY
// Existing API)... ValidateFeature() / ValidateUsage()." The real, generic,
// reusable middleware pieces of the spec's own literal chain
// `Authenticate() -> ValidateTenant() -> ValidateSubscription() -> ...`.
//
// `ValidateTenant()`/`ValidateSubscription()` already exist and already
// run on every authenticated request — they're the enforcement check
// already built into middleware/authenticateAccessToken.js (Improvement
// 1), not duplicated here. `ValidatePlan()` is not a separate real check —
// a subscription's own status already IS its plan's applicability; there
// is no additional real state a standalone plan-validity check would add
// beyond what the subscription-status check already covers.
// `ValidateCompany()` is Tenant Validation under a different name (Company
// IS Tenant). `ValidateBranch()` has no backing — this codebase has no
// Branch concept, per the standing master instructions.
//
// So the two genuinely new, real, generic primitives this Part builds are
// below: `requireFeature` and `requireUsageLimit`. Both are backward-
// compatible by construction — `TenantSubscriptionService.checkFeatureAccess`/
// `checkUsageLimit` already default to "allowed" for any tenant with no
// real TenantSubscriptionModel row (every tenant that predates this
// platform), so applying either middleware to an existing route never
// changes behavior for an unmanaged tenant.

/**
 * "Feature Validation... Inventory Enabled? -> YES -> Continue / NO ->
 * 403 Feature Not Available." Router-level usage (`router.use(...)`)
 * gates an entire module's routes with one line — this codebase's real
 * module boundaries (one router file per domain) already match the
 * spec's own per-module feature-gate examples (Finance/CRM/...) exactly,
 * so a single middleware call per router file is the real, correct
 * "every endpoint" retrofit — not hundreds of individual per-route edits.
 */
export const requireFeature = (featureKey) => async (req, res, next) => {
  const requestId = req.requestId || null;
  const scope = getAccessScope(req);
  if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);

  try {
    const allowed = await TenantSubscriptionService.checkFeatureAccess(scope.tenantId, featureKey);
    if (!allowed) return sendError(res, 403, "Feature Not Included In Plan", requestId, { code: "FEATURE_NOT_AVAILABLE", featureKey });
    next();
  } catch (error) {
    // Fail OPEN — same discipline as the enforcement check in
    // authenticateAccessToken.js: an availability bug in this platform
    // must never itself become a reason a real business request is
    // blocked.
    next();
  }
};

/**
 * "Usage Validation... Starter Plan Maximum Users 20... 21st create ->
 * Reject -> 403 User Limit Exceeded." Generic over any real, already-
 * countable resource — the caller supplies both `limitKey` (config-driven
 * `tenantLimitKeys`) and its own real `countFn(tenantId)` (an async
 * function returning the real current count via that module's own model,
 * e.g. `() => EmployeeProfileModel.countDocuments({tenantId, status:
 * "active"})`) — this middleware never counts anything itself, never
 * fabricates a number for a resource type it doesn't own.
 */
export const requireUsageLimit = (limitKey, countFn) => async (req, res, next) => {
  const requestId = req.requestId || null;
  const scope = getAccessScope(req);
  if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);

  try {
    const currentCount = await countFn(scope.tenantId, req);
    const { allowed, limit } = await TenantSubscriptionService.checkUsageLimit(scope.tenantId, limitKey, currentCount);
    if (!allowed) {
      const message = LIMIT_MESSAGES[limitKey] || "Usage Limit Exceeded";
      return sendError(res, 403, message, requestId, { code: "USAGE_LIMIT_EXCEEDED", limitKey, limit, current: currentCount });
    }
    next();
  } catch (error) {
    next(); // Fail open — same reasoning as requireFeature above.
  }
};

// "New Error Codes... 403 User Limit Exceeded / 403 Storage Limit
// Exceeded." Real, specific messages per limit key — config-driven
// (utils/platformConfig.js tenantLimitKeys), not a single generic string
// for every kind of limit.
const LIMIT_MESSAGES = {
  maxUsers: "User Limit Exceeded",
  maxEmployees: "User Limit Exceeded",
  maxStorageGB: "Storage Limit Exceeded",
  maxApiCallsPerDay: "API Usage Limit Exceeded",
  maxProjects: "Project Limit Exceeded",
  aiCreditsPerMonth: "AI Credit Limit Exceeded"
};

/**
 * "New Common Headers... X-Tenant-Id, X-Subscription-Id, X-Plan,
 * X-Feature-Version. Useful for debugging." Real, read-only, set on
 * every response for a request that reached a real tenant scope —
 * `X-Company-Id`/`X-Branch-Id` from the spec's own list are deliberately
 * absent (Company IS Tenant already; no Branch concept). A no-op (never
 * blocks) for any tenant with no subscription row.
 */
export const subscriptionResponseHeaders = async (req, res, next) => {
  const scope = getAccessScope(req);
  if (scope) {
    res.setHeader("X-Tenant-Id", scope.tenantId);
    try {
      const subscription = await TenantSubscriptionService.getSubscriptionSummary(scope.tenantId);
      if (subscription) {
        res.setHeader("X-Subscription-Id", subscription.subscriptionId);
        res.setHeader("X-Plan", subscription.planCode);
        res.setHeader("X-Feature-Version", subscription.planTier);
      }
    } catch (error) {
      // Headers are debugging aids, never a reason to fail a real request.
    }
  }
  next();
};
