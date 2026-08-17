import PurgeRequestModel from "../models/PurgeRequestModel.js";
import LegalHoldModel from "../models/LegalHoldModel.js";
import AuditLogModel from "../models/AuditLogmodel.js";
import { publishVersionedEvent } from "./eventVersioning.js";
import { getCorrelationId } from "./correlationContext.js";
import { getRetentionConfig } from "./retentionConfig.js";

const EVENT_OWNER = "Enterprise Retention Platform";

/**
 * Enterprise Data Retention & Legal Hold Standard (Enterprise Architecture
 * Hardening Phase, Improvement 11). "Purge Approval — Retention Complete
 * -> Compliance Officer -> Finance Manager -> System Approval -> Secure
 * Purge -> Audit Event. No automatic deletion without approval." A real,
 * queryable request/approve gate — deliberately simple (Pending ->
 * Approved/Rejected), not a second general-purpose approval-workflow
 * engine (this codebase already has one:
 * `services/ApprovalWorkflowService.js`). Approving a request here does
 * NOT itself delete anything — the caller takes the resulting real
 * `approvedBy` and passes it into Improvement 10's own
 * `utils/archivalService.js#purgeRecord`, which performs the actual
 * gated hard delete.
 */
export const requestPurge = async ({ resourceType, resourceId, reason, requestedBy, tenantId, correlationId = null }) => {
  if (!reason) throw new Error("reason is required to request a purge.");
  if (!requestedBy) throw new Error("requestedBy is required.");
  const resolvedCorrelationId = correlationId || getCorrelationId() || null;

  const activeHold = await LegalHoldModel.exists({ tenantId, resourceType, resourceId, status: "Active" });
  if (activeHold) throw new Error(`${resourceType} is under an active legal hold and cannot be queued for purge.`);

  const request = await PurgeRequestModel.create({ tenantId, resourceType, resourceId, reason, status: "Pending", requestedBy });

  await AuditLogModel.create({
    action: "purge.requested", tenantId, requestId: resolvedCorrelationId || undefined,
    module: "EnterpriseRetention", resource: resourceType, resourceId: String(resourceId), details: { reason, requestId: request._id.toString() }
  });

  return request.toJSON();
};

export const approvePurge = async (purgeRequestId, approvedBy, tenantId, correlationId = null) => {
  if (!approvedBy) throw new Error("approvedBy is required.");
  const resolvedCorrelationId = correlationId || getCorrelationId() || null;

  const request = await PurgeRequestModel.findOne({ _id: purgeRequestId, tenantId });
  if (!request) throw new Error("Purge request not found.");
  if (request.status !== "Pending") throw new Error(`Cannot approve a purge request in status "${request.status}".`);

  const activeHold = await LegalHoldModel.exists({ tenantId, resourceType: request.resourceType, resourceId: request.resourceId, status: "Active" });
  if (activeHold) throw new Error(`${request.resourceType} is now under an active legal hold — cannot approve this purge request.`);

  request.status = "Approved";
  request.approvedBy = approvedBy;
  request.approvedAt = new Date();
  await request.save();

  await AuditLogModel.create({
    action: "purge.approved", tenantId, requestId: resolvedCorrelationId || undefined,
    module: "EnterpriseRetention", resource: request.resourceType, resourceId: request.resourceId, details: { requestId: request._id.toString(), approvedBy }
  });
  await publishVersionedEvent({
    eventName: "PurgeApproved", version: 1, category: "Domain", owner: EVENT_OWNER, source: EVENT_OWNER,
    tenantId, correlationId: resolvedCorrelationId, data: { requestId: request._id.toString(), resourceType: request.resourceType, resourceId: request.resourceId, approvedBy }
  });

  return request.toJSON();
};

export const rejectPurge = async (purgeRequestId, rejectedBy, reason, tenantId, correlationId = null) => {
  const resolvedCorrelationId = correlationId || getCorrelationId() || null;
  const request = await PurgeRequestModel.findOne({ _id: purgeRequestId, tenantId });
  if (!request) throw new Error("Purge request not found.");
  if (request.status !== "Pending") throw new Error(`Cannot reject a purge request in status "${request.status}".`);

  request.status = "Rejected";
  request.rejectedBy = rejectedBy;
  request.rejectedAt = new Date();
  request.rejectionReason = reason || null;
  await request.save();

  await AuditLogModel.create({
    action: "purge.rejected", tenantId, requestId: resolvedCorrelationId || undefined,
    module: "EnterpriseRetention", resource: request.resourceType, resourceId: request.resourceId, details: { requestId: request._id.toString(), rejectedBy, reason }
  });

  return request.toJSON();
};

/** Called by the caller AFTER a real `purgeRecord` (Improvement 10) actually succeeds — marks the request's own lifecycle Completed so the "Purge History" view reflects reality, not just the approval step. */
export const markPurgeRequestCompleted = async (purgeRequestId, tenantId) => {
  const request = await PurgeRequestModel.findOne({ _id: purgeRequestId, tenantId });
  if (!request) throw new Error("Purge request not found.");
  if (request.status !== "Approved") throw new Error(`Cannot complete a purge request in status "${request.status}".`);
  request.status = "Completed";
  request.completedAt = new Date();
  await request.save();
  return request.toJSON();
};

export const listPurgeRequests = async (tenantId, query = {}) => {
  const config = getRetentionConfig();
  const filter = { tenantId };
  if (query.status) filter.status = query.status;
  if (query.resourceType) filter.resourceType = query.resourceType;
  const page = Math.max(parseInt(query.page, 10) || 1, 1);
  const pageSize = Math.min(Math.max(parseInt(query.pageSize, 10) || config.defaultPageSize, 1), config.maxPageSize);

  const [items, total] = await Promise.all([
    PurgeRequestModel.find(filter).sort({ createdAt: -1 }).skip((page - 1) * pageSize).limit(pageSize).lean(),
    PurgeRequestModel.countDocuments(filter)
  ]);
  return { items, pagination: { total, page, pageSize, totalPages: Math.ceil(total / pageSize) } };
};
