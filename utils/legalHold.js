import LegalHoldModel from "../models/LegalHoldModel.js";
import AuditLogModel from "../models/AuditLogmodel.js";
import { publishVersionedEvent } from "./eventVersioning.js";
import { getCorrelationId } from "./correlationContext.js";

const EVENT_OWNER = "Enterprise Retention Platform";

/**
 * Enterprise Data Retention & Legal Hold Standard (Enterprise Architecture
 * Hardening Phase, Improvement 11). "Legal Hold MUST override all purge
 * operations... NO record may be deleted." Reuses the exact `legalHold`/
 * `legalHoldReason` fields Improvement 10's own `applyArchivalPolicy`
 * already put on the target document (and that `purgeRecord` already
 * checks) — this file is the real REGISTRY on top: a resource can be
 * under more than one hold at once (a tax investigation AND a fraud
 * investigation, independently opened and closed), and the flag on the
 * target document only clears once every real hold against it has been
 * removed.
 */
export const applyLegalHold = async ({ Model, filter, resourceType, resourceId, reason, userId, tenantId, correlationId = null }) => {
  if (!reason) throw new Error("reason is required to apply a legal hold.");
  if (!userId) throw new Error("userId is required to apply a legal hold.");
  const resolvedCorrelationId = correlationId || getCorrelationId() || null;

  const doc = await Model.findOne(filter);
  if (!doc) throw new Error(`${resourceType} not found.`);

  const hold = await LegalHoldModel.create({ tenantId, resourceType, resourceId, reason, status: "Active", appliedBy: userId });

  doc.legalHold = true;
  doc.legalHoldReason = reason;
  await doc.save();

  await AuditLogModel.create({
    action: "legalhold.applied", tenantId, requestId: resolvedCorrelationId || undefined,
    module: "EnterpriseRetention", resource: resourceType, resourceId: String(resourceId), details: { reason, holdId: String(hold._id) }
  });
  await publishVersionedEvent({
    eventName: "LegalHoldApplied", version: 1, category: "Domain", owner: EVENT_OWNER, source: EVENT_OWNER,
    tenantId, correlationId: resolvedCorrelationId, data: { resourceType, resourceId: String(resourceId), reason, appliedBy: userId, holdId: String(hold._id) }
  });

  return hold.toJSON();
};

/**
 * Removing ONE hold never clears the flag while another real, independent
 * hold against the same resource is still Active — "Legal Hold MUST
 * suspend retention countdown where required" only actually ends once
 * every genuine reason to preserve the record is gone.
 */
export const removeLegalHold = async ({ Model, filter, resourceType, resourceId, holdId, userId, tenantId, correlationId = null, removalReason = null }) => {
  if (!userId) throw new Error("userId is required to remove a legal hold.");
  const resolvedCorrelationId = correlationId || getCorrelationId() || null;

  const hold = await LegalHoldModel.findOne({ _id: holdId, tenantId, resourceType, resourceId, status: "Active" });
  if (!hold) throw new Error("Active legal hold not found.");

  hold.status = "Removed";
  hold.removedBy = userId;
  hold.removedAt = new Date();
  hold.removalReason = removalReason;
  await hold.save();

  const remainingActive = await LegalHoldModel.countDocuments({ tenantId, resourceType, resourceId, status: "Active" });
  if (remainingActive === 0) {
    const doc = await Model.findOne(filter);
    if (doc) {
      doc.legalHold = false;
      doc.legalHoldReason = null;
      await doc.save();
    }
  }

  await AuditLogModel.create({
    action: "legalhold.removed", tenantId, requestId: resolvedCorrelationId || undefined,
    module: "EnterpriseRetention", resource: resourceType, resourceId: String(resourceId), details: { removalReason, holdId: String(hold._id), remainingActiveHolds: remainingActive }
  });
  await publishVersionedEvent({
    eventName: "LegalHoldRemoved", version: 1, category: "Domain", owner: EVENT_OWNER, source: EVENT_OWNER,
    tenantId, correlationId: resolvedCorrelationId, data: { resourceType, resourceId: String(resourceId), removedBy: userId, holdId: String(hold._id), stillUnderHold: remainingActive > 0 }
  });

  return hold.toJSON();
};

/** "Search Behaviour — Users immediately know why a record cannot be deleted." Real current status, not just the boolean flag. */
export const getLegalHoldStatus = async (tenantId, resourceType, resourceId) => {
  const activeHolds = await LegalHoldModel.find({ tenantId, resourceType, resourceId, status: "Active" }).lean();
  return { underLegalHold: activeHolds.length > 0, activeHolds };
};

export const listActiveLegalHolds = async (tenantId, query = {}) => {
  const filter = { tenantId, status: "Active" };
  if (query.resourceType) filter.resourceType = query.resourceType;
  const items = await LegalHoldModel.find(filter).sort({ appliedAt: -1 }).lean();
  return { items };
};
