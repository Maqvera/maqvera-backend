import RateLimitRuleModel from "../models/RateLimitRuleModel.js";
import { publishVersionedEvent } from "./eventVersioning.js";
import { getRateLimitConfig } from "./rateLimitConfig.js";

const EVENT_OWNER = "Enterprise Rate Limiting Platform";

/**
 * Enterprise API Rate Limiting & Throttling Standard (Enterprise
 * Architecture Hardening Phase, Improvement 13). "All values
 * configurable." Real registry — a `tenantId: null` row is a
 * platform-wide default for a (scope, ruleKey) pair; a tenant-specific
 * row overrides it. Every real CHANGE (not a same-value re-registration)
 * publishes `RateLimitConfigurationChanged.v1`.
 */
export const registerRateLimitRule = async (tenantId, scope, ruleKey, { limit, windowSeconds, priority = "Medium", owner, description = null, userId = null }) => {
  const config = getRateLimitConfig();
  if (!config.scopes.includes(scope)) throw new Error(`Invalid scope "${scope}".`);
  if (!Number.isFinite(limit) || limit < 0) throw new Error("limit must be a non-negative number.");
  if (!Number.isFinite(windowSeconds) || windowSeconds < 1) throw new Error("windowSeconds must be a positive number.");
  if (!owner) throw new Error("owner is required.");

  const existing = await RateLimitRuleModel.findOne({ tenantId: tenantId || null, scope, ruleKey: ruleKey || null });
  if (!existing) {
    const created = await RateLimitRuleModel.create({ tenantId: tenantId || null, scope, ruleKey: ruleKey || null, limit, windowSeconds, priority, owner, description, status: "Active", createdBy: userId, updatedBy: userId });
    await publishVersionedEvent({ eventName: "RateLimitConfigurationChanged", version: 1, category: "System", owner: EVENT_OWNER, source: EVENT_OWNER, tenantId: tenantId || null, data: { scope, ruleKey, limit, windowSeconds, action: "created" } });
    return created.toJSON();
  }

  const changed = existing.limit !== limit || existing.windowSeconds !== windowSeconds || existing.priority !== priority;
  existing.limit = limit;
  existing.windowSeconds = windowSeconds;
  existing.priority = priority;
  if (description) existing.description = description;
  existing.owner = owner;
  existing.updatedBy = userId;
  await existing.save();

  if (changed) {
    await publishVersionedEvent({ eventName: "RateLimitConfigurationChanged", version: 1, category: "System", owner: EVENT_OWNER, source: EVENT_OWNER, tenantId: tenantId || null, data: { scope, ruleKey, limit, windowSeconds, action: "updated" } });
  }
  return existing.toJSON();
};

/** Real resolution order: tenant-specific override for this exact (scope, ruleKey) -> platform-wide default row for it -> null (caller falls back to utils/rateLimitConfig.js's own static defaults). */
export const findApplicableRule = async (tenantId, scope, ruleKey = null) => {
  if (tenantId) {
    const tenantRule = await RateLimitRuleModel.findOne({ tenantId, scope, ruleKey: ruleKey || null, status: "Active" }).lean();
    if (tenantRule) return tenantRule;
  }
  return RateLimitRuleModel.findOne({ tenantId: null, scope, ruleKey: ruleKey || null, status: "Active" }).lean();
};

export const listRateLimitRules = async (query = {}) => {
  const config = getRateLimitConfig();
  const filter = {};
  if (query.tenantId !== undefined) filter.tenantId = query.tenantId || null;
  if (query.scope) filter.scope = query.scope;
  if (query.status) filter.status = query.status;
  const page = Math.max(parseInt(query.page, 10) || 1, 1);
  const pageSize = Math.min(Math.max(parseInt(query.pageSize, 10) || config.defaultPageSize, 1), config.maxPageSize);

  const [items, total] = await Promise.all([
    RateLimitRuleModel.find(filter).sort({ scope: 1, ruleKey: 1 }).skip((page - 1) * pageSize).limit(pageSize).lean(),
    RateLimitRuleModel.countDocuments(filter)
  ]);
  return { items, pagination: { total, page, pageSize, totalPages: Math.ceil(total / pageSize) } };
};
