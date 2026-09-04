import RateLimitCounterModel from "../models/RateLimitCounterModel.js";
import RateLimitViolationModel from "../models/RateLimitViolationModel.js";
import AuditLogModel from "../models/AuditLogmodel.js";
import TenantBillingAccountModel from "../models/TenantBillingAccountModel.js";
import TenantSubscriptionModel from "../models/TenantSubscriptionModel.js";
import PlatformPlanModel from "../models/PlatformPlanModel.js";
import { publishVersionedEvent } from "./eventVersioning.js";
import { findApplicableRule } from "./rateLimitRules.js";
import { getRateLimitConfig } from "./rateLimitConfig.js";
import { getCorrelationId } from "./correlationContext.js";

const EVENT_OWNER = "Enterprise Rate Limiting Platform";

/**
 * Enterprise API Rate Limiting & Throttling Standard (Enterprise
 * Architecture Hardening Phase, Improvement 13). The real, distributed
 * (MongoDB-backed, shared across every API node) counter and decision
 * engine `middleware/rateLimiter.js` calls on every request.
 */

const bucketWindow = (windowSeconds, now = Date.now()) => {
  const windowMs = windowSeconds * 1000;
  const windowStartMs = Math.floor(now / windowMs) * windowMs;
  return { windowStart: new Date(windowStartMs), resetAt: new Date(windowStartMs + windowMs) };
};

/** Real per-tenant plan lookup — "Subscription-Aware Limits... Starter 10,000/hour, Professional 100,000/hour, Enterprise Custom/Unlimited." `null`/`0` on the plan's own `limits.maxApiCallsPerDay` (Improvement... the Enterprise Subscription Platform's own pre-existing field) means unlimited, never fabricated as a large number. */
export const resolvePlanApiLimit = async (tenantId) => {
  if (!tenantId) return null;
  const subscription = await TenantSubscriptionModel.findOne({ tenantId }).lean();
  if (!subscription?.planId) return null;
  const plan = await PlatformPlanModel.findById(subscription.planId).lean();
  if (!plan?.limits?.maxApiCallsPerDay) return null;
  return { limit: plan.limits.maxApiCallsPerDay, windowSeconds: 86400, planCode: plan.planCode };
};

/** Real cross-context lookup — reuses Improvement 3's own `TenantBillingAccountModel.merchantAccountId`, never a second, parallel merchant-linkage field. */
export const resolveMerchantAccountId = async (tenantId) => {
  if (!tenantId) return null;
  const billingAccount = await TenantBillingAccountModel.findOne({ tenantId }).lean();
  return billingAccount?.merchantAccountId ? String(billingAccount.merchantAccountId) : null;
};

/**
 * Tenant-specific admin rule (RateLimitRuleModel, an explicit override) ->
 * the tenant's OWN real plan-based limit (Enterprise Subscription
 * Enforcement Middleware, Automation #6: "API Rate Limiting Integration...
 * Plan -> Requests/Minute") -> named rule default -> config static default
 * -> priority multiplier applied last. `resolvePlanApiLimit` already
 * existed (Improvement 13) but was never actually wired into this real
 * decision chain until this automation — real, per-plan
 * `PlatformPlanModel.limits.maxApiCallsPerDay` now genuinely throttles
 * Tenant-scoped requests, not just a tested-in-isolation helper. Only
 * consulted for `scope: "Tenant"` — a plan ceiling is fundamentally a
 * tenant-level concept, not a per-IP/per-endpoint one — and only when no
 * explicit admin rule exists (specific override always wins over the
 * general plan default).
 */
export const resolveLimit = async ({ tenantId, scope, ruleKey = null, priority = "Medium" }) => {
  const config = getRateLimitConfig();
  const rule = await findApplicableRule(tenantId, scope, ruleKey);
  const planLimit = (!rule && scope === "Tenant") ? await resolvePlanApiLimit(tenantId) : null;
  let limit, windowSeconds;
  if (rule) {
    ({ limit, windowSeconds } = rule);
  } else if (planLimit) {
    ({ limit, windowSeconds } = planLimit);
  } else if (ruleKey && config.namedRuleDefaults[ruleKey]) {
    ({ limit, windowSeconds } = config.namedRuleDefaults[ruleKey]);
  } else {
    const fallback = config.defaultLimits[scope] || { limit: 1000, windowSeconds: 3600 };
    ({ limit, windowSeconds } = fallback);
  }

  const multiplier = config.priorityMultipliers[priority] ?? 1;
  return { limit: Math.max(Math.round(limit * multiplier), 1), windowSeconds, priority };
};

const recordViolation = async ({ tenantId, scope, ruleKey, identifier, limit, windowSeconds, count, requestPath, correlationId }) => {
  await RateLimitViolationModel.create({ tenantId, scope, ruleKey, identifier, limit, windowSeconds, count, requestPath, correlationId, occurredAt: new Date() });
  await AuditLogModel.create({
    action: "ratelimit.exceeded", outcome: "blocked", tenantId, requestId: correlationId || undefined,
    module: "EnterpriseRateLimiting", resource: scope, resourceId: identifier, details: { ruleKey, limit, windowSeconds, count, requestPath }
  });
  await publishVersionedEvent({
    eventName: "RateLimitExceeded", version: 1, category: "System", owner: EVENT_OWNER, source: EVENT_OWNER,
    tenantId, correlationId, data: { scope, ruleKey, identifier, limit, windowSeconds, count }
  });

  const config = getRateLimitConfig();
  const abuseWindowStart = new Date(Date.now() - config.abuseWindowMinutes * 60 * 1000);
  const recentViolations = await RateLimitViolationModel.countDocuments({ scope, identifier, occurredAt: { $gte: abuseWindowStart } });
  if (recentViolations >= config.abuseViolationThreshold) {
    await publishVersionedEvent({
      eventName: "AbuseDetected", version: 1, category: "Domain", owner: EVENT_OWNER, source: EVENT_OWNER,
      tenantId, correlationId, data: { scope, identifier, violationsInWindow: recentViolations, windowMinutes: config.abuseWindowMinutes }
    });
  }
};

/**
 * Real atomic increment against the shared MongoDB counter (genuinely
 * distributed across every API node, same proven pattern as
 * `FinanceSequenceModel`). Returns `{ allowed, limit, count, remaining,
 * resetAt }`. A violation is recorded/audited/published ONLY the first
 * time a given bucket crosses the limit (`count === limit + 1`) — every
 * request within a bucket that's ALREADY over the limit is still
 * correctly rejected, just without re-logging a duplicate violation for
 * every single one of them.
 */
export const checkRateLimit = async ({ scope, ruleKey = null, identifier, limit, windowSeconds, tenantId = null, correlationId = null, requestPath = null }) => {
  const resolvedCorrelationId = correlationId || getCorrelationId() || null;
  const { windowStart, resetAt } = bucketWindow(windowSeconds);
  const bucketKey = `${scope}:${ruleKey || "_"}:${identifier}:${windowStart.getTime()}`;

  const counter = await RateLimitCounterModel.incrementAndGet(bucketKey, windowStart, new Date(resetAt.getTime() + 5000));
  const allowed = counter.count <= limit;

  if (!allowed && counter.count === limit + 1) {
    await recordViolation({ tenantId, scope, ruleKey, identifier, limit, windowSeconds, count: counter.count, requestPath, correlationId: resolvedCorrelationId });
  }

  return { allowed, limit, count: counter.count, remaining: Math.max(limit - counter.count, 0), resetAt };
};

/** "Burst Protection" — a real, separate short-window check alongside the main one. Detection + event only in this pass (no automatic extra delay applied) — see docs/07-enterprise-standards/13-rate-limiting.md "Adoption". */
export const checkBurst = async ({ scope, identifier, mainLimit, tenantId = null, correlationId = null }) => {
  const config = getRateLimitConfig();
  const resolvedCorrelationId = correlationId || getCorrelationId() || null;
  const burstLimit = Math.max(Math.round(mainLimit * config.burstRatio), 1);
  const { windowStart } = bucketWindow(config.burstWindowSeconds);
  const bucketKey = `Burst:${scope}:${identifier}:${windowStart.getTime()}`;

  const counter = await RateLimitCounterModel.incrementAndGet(bucketKey, windowStart, new Date(windowStart.getTime() + config.burstWindowSeconds * 1000 + 5000));
  const burstDetected = counter.count === burstLimit + 1;

  if (burstDetected) {
    await publishVersionedEvent({
      eventName: "BurstDetected", version: 1, category: "System", owner: EVENT_OWNER, source: EVENT_OWNER,
      tenantId, correlationId: resolvedCorrelationId, data: { scope, identifier, burstLimit, windowSeconds: config.burstWindowSeconds, count: counter.count }
    });
  }

  return { burstDetected, count: counter.count, burstLimit };
};

/** Real `countFn` for `middleware/subscriptionEnforcement.js#requireUsageLimit("maxApiCallsPerDay", ...)` — the piece that middleware always needed but never had for this specific limit key (every other limit key already has a real, module-owned collection to count against). */
export const getApiCallCountToday = async (tenantId) => {
  const { windowStart, resetAt } = bucketWindow(86400);
  const bucketKey = `Tenant:_:${tenantId}:${windowStart.getTime()}`;
  const counter = await RateLimitCounterModel.findOne({ bucketKey }).lean();
  return counter?.count || 0;
};
