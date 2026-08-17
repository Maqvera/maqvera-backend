import RetentionPolicyModel from "../models/RetentionPolicyModel.js";
import { publishVersionedEvent } from "./eventVersioning.js";
import { getRetentionConfig } from "./retentionConfig.js";

const EVENT_OWNER = "Enterprise Retention Platform";

/**
 * Enterprise Data Retention & Legal Hold Standard (Enterprise Architecture
 * Hardening Phase, Improvement 11). "Every business entity MUST have an
 * assigned retention policy. Retention periods MUST be configurable by
 * jurisdiction, tenant, and document type." One real, upsert-safe policy
 * per (tenantId, resourceType) — `registerRetentionPolicy` is idempotent
 * for identical re-registration, but changing the actual retention window
 * on an existing policy is a real, auditable, event-publishing act
 * (`RetentionPolicyChanged.v1`), not a silent overwrite.
 */
export const registerRetentionPolicy = async (tenantId, resourceType, { policyCode, retentionYears, jurisdiction = null, description = null, owner, userId = null }) => {
  const config = getRetentionConfig();
  if (!tenantId || !resourceType) throw new Error("tenantId and resourceType are required.");
  if (!policyCode) throw new Error("policyCode is required.");
  if (!Number.isFinite(retentionYears) || retentionYears < 0) throw new Error("retentionYears must be a non-negative number.");
  if (!owner) throw new Error("owner is required.");

  const existing = await RetentionPolicyModel.findOne({ tenantId, resourceType });
  if (!existing) {
    const created = await RetentionPolicyModel.create({ tenantId, resourceType, policyCode, retentionYears, jurisdiction, description, owner, status: "Active", createdBy: userId, updatedBy: userId });
    return created.toJSON();
  }

  const changed = existing.policyCode !== policyCode || existing.retentionYears !== retentionYears || existing.jurisdiction !== jurisdiction;
  existing.policyCode = policyCode;
  existing.retentionYears = retentionYears;
  existing.jurisdiction = jurisdiction;
  if (description) existing.description = description;
  existing.owner = owner;
  existing.updatedBy = userId;
  await existing.save();

  if (changed) {
    await publishVersionedEvent({
      eventName: "RetentionPolicyChanged", version: 1, category: "System", owner: EVENT_OWNER, source: EVENT_OWNER,
      tenantId, data: { resourceType, policyCode, retentionYears, jurisdiction, changedBy: userId }
    });
  }

  return existing.toJSON();
};

/** Real resolution order: an explicit registered policy first, then the config's own per-resourceType default table, then the honest fallback — never a silently guessed number. */
export const resolveRetentionYears = async (tenantId, resourceType) => {
  const registered = await RetentionPolicyModel.findOne({ tenantId, resourceType, status: "Active" }).lean();
  if (registered) return { retentionYears: registered.retentionYears, policyCode: registered.policyCode };

  const config = getRetentionConfig();
  const fromTable = config.defaultRetentionYearsByResourceType[resourceType];
  if (Number.isFinite(fromTable)) return { retentionYears: fromTable, policyCode: null };

  return { retentionYears: config.fallbackRetentionYears, policyCode: null };
};

export const getRetentionPolicy = async (tenantId, resourceType) => {
  const policy = await RetentionPolicyModel.findOne({ tenantId, resourceType }).lean();
  if (!policy) throw new Error("Retention policy not found.");
  return policy;
};

export const listRetentionPolicies = async (tenantId, query = {}) => {
  const config = getRetentionConfig();
  const filter = { tenantId };
  if (query.resourceType) filter.resourceType = query.resourceType;
  if (query.status) filter.status = query.status;
  const page = Math.max(parseInt(query.page, 10) || 1, 1);
  const pageSize = Math.min(Math.max(parseInt(query.pageSize, 10) || config.defaultPageSize, 1), config.maxPageSize);

  const [items, total] = await Promise.all([
    RetentionPolicyModel.find(filter).sort({ resourceType: 1 }).skip((page - 1) * pageSize).limit(pageSize).lean(),
    RetentionPolicyModel.countDocuments(filter)
  ]);
  return { items, pagination: { total, page, pageSize, totalPages: Math.ceil(total / pageSize) } };
};
