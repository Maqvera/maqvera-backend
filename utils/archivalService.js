import AuditLogModel from "../models/AuditLogmodel.js";
import FinancialPeriodService from "../services/FinancialPeriodService.js";
import { publishVersionedEvent } from "./eventVersioning.js";
import { AppError } from "./errorContract.js";
import { getArchivalConfig } from "./archivalConfig.js";
import { getCorrelationId } from "./correlationContext.js";
import { resolveRetentionYears } from "./retentionPolicy.js";

/**
 * Enterprise Soft Delete & Archival Standard (Enterprise Architecture
 * Hardening Phase, Improvement 10). "Financial records are NEVER
 * physically deleted... Instead: Create -> Active -> Archived -> Restored
 * (optional) -> Retention Period Ends -> Legal Review -> Secure Purge (if
 * permitted)." This codebase already follows that rule in practice — no
 * hard `deleteOne`/`deleteMany`/`findOneAndDelete` exists anywhere
 * against Invoice/Payment/Journal/Receipt/CreditNote/DebitNote models
 * today. This file is the real, reusable engine for the workflow itself
 * (archive/restore/purge, with the spec's own accounting-period,
 * retention, and legal-hold gates) — deliberately NOT wired into any
 * existing controller in this pass; see
 * docs/07-enterprise-standards/10-soft-delete-archival.md "Adoption".
 *
 * Permission checks (who is allowed to call these) are the CALLER's
 * responsibility (same convention as every service in this codebase) —
 * this file never hardcodes a role-name allowlist ("Finance Manager,
 * Controller, CFO..."); a real controller gates on
 * `req.auth.permissions` (e.g. `archive.manage`), the same RBAC this
 * whole codebase already uses everywhere else.
 */

const EVENT_OWNER = "Enterprise Archival Platform";

const addYears = (date, years) => {
  const result = new Date(date);
  result.setFullYear(result.getFullYear() + years);
  return result;
};

/** "Hard Delete — NEVER" for financial resource types; real, explicit allow-list for genuinely operational data (Temporary Reports, Cache, Sessions, ...). */
export const assertHardDeleteAllowed = (resourceType) => {
  const config = getArchivalConfig();
  if (config.financialResourceTypes.includes(resourceType)) {
    throw new Error(`${resourceType} is a financial record and can never be physically deleted — archive it instead (archiveRecord).`);
  }
  if (config.hardDeleteAllowedResourceTypes.length > 0 && !config.hardDeleteAllowedResourceTypes.includes(resourceType)) {
    throw new Error(`${resourceType} is not on the explicit hard-delete allow-list — archive it instead unless this is genuinely operational data.`);
  }
};

/**
 * "Archive Workflow: Permission Validation -> Accounting Period Check ->
 * Archive Metadata Added -> Audit Record Created -> ... -> Archived."
 * `periodDate` is optional — supply it (e.g. an invoice's own
 * `issueDate`) to enforce "Closed Accounting Period" rejection via the
 * already-real `FinancialPeriodService.assertPeriodOpen`; omitted for
 * resource types with no accounting-period concept at all.
 */
export const archiveRecord = async ({ Model, filter, resourceType, reason, userId = null, tenantId = null, correlationId = null, periodDate = null, retentionYears = null }) => {
  if (!reason) throw new Error("reason is required to archive a record.");
  const config = getArchivalConfig();
  const resolvedCorrelationId = correlationId || getCorrelationId() || null;

  const doc = await Model.findOne(filter);
  if (!doc) throw new Error(`${resourceType} not found.`);
  if (doc.isArchived) throw new Error(`${resourceType} is already archived.`);

  if (periodDate) {
    try {
      await FinancialPeriodService.assertPeriodOpen(tenantId, periodDate);
    } catch (error) {
      await AuditLogModel.create({
        action: "archival.rejected", outcome: "failure", tenantId, requestId: resolvedCorrelationId || undefined,
        module: "EnterpriseArchival", resource: resourceType, resourceId: String(doc._id), details: { reason: error.message }
      });
      await publishVersionedEvent({
        eventName: "ArchiveRejected", version: 1, category: "Domain", owner: EVENT_OWNER, source: EVENT_OWNER,
        tenantId, correlationId: resolvedCorrelationId, data: { resourceType, resourceId: String(doc._id), reason: error.message }
      });
      throw new AppError("ACCOUNTING_PERIOD_CLOSED", { message: error.message, details: { resourceType, resourceId: String(doc._id) } });
    }
  }

  // Data Retention & Legal Hold Standard (Improvement 11) — an explicit
  // `retentionYears` override always wins (unchanged from Improvement 10);
  // otherwise resolve against a real registered policy
  // (`utils/retentionPolicy.js`) before falling back to the honest config
  // default, never a silently guessed number either way.
  let resolvedRetentionYears = retentionYears;
  let resolvedPolicyCode = null;
  if (!resolvedRetentionYears) {
    const resolved = await resolveRetentionYears(tenantId, resourceType);
    resolvedRetentionYears = resolved.retentionYears;
    resolvedPolicyCode = resolved.policyCode;
  }

  doc.isArchived = true;
  doc.archivedAt = new Date();
  doc.archivedBy = userId;
  doc.archiveReason = reason;
  doc.purgeEligibleAt = addYears(new Date(), resolvedRetentionYears || config.defaultRetentionYears);
  doc.retentionPolicy = resolvedPolicyCode;
  await doc.save();

  await AuditLogModel.create({
    action: "archival.archived", tenantId, requestId: resolvedCorrelationId || undefined,
    module: "EnterpriseArchival", resource: resourceType, resourceId: String(doc._id), details: { reason, retentionPolicy: resolvedPolicyCode, retentionYears: resolvedRetentionYears }
  });
  await publishVersionedEvent({
    eventName: "RecordArchived", version: 1, category: "Domain", owner: EVENT_OWNER, source: EVENT_OWNER,
    tenantId, correlationId: resolvedCorrelationId, data: { resourceType, resourceId: String(doc._id), reason, archivedBy: userId }
  });
  // "Archived -> Retention Countdown Starts" — retention conceptually
  // begins the moment a record is archived, a real, separate signal from
  // "the record was archived" itself (a consumer may care about one
  // without the other — e.g. a retention-tracking dashboard vs. a
  // search-index updater).
  await publishVersionedEvent({
    eventName: "RetentionStarted", version: 1, category: "System", owner: EVENT_OWNER, source: EVENT_OWNER,
    tenantId, correlationId: resolvedCorrelationId, data: { resourceType, resourceId: String(doc._id), retentionPolicy: resolvedPolicyCode, retentionUntil: doc.purgeEligibleAt }
  });

  return doc.toJSON ? doc.toJSON() : doc;
};

/** "Restore API — only authorised users" (enforced by the caller). Real state check — cannot restore a record that isn't archived. */
export const restoreRecord = async ({ Model, filter, resourceType, userId = null, tenantId = null, correlationId = null }) => {
  const resolvedCorrelationId = correlationId || getCorrelationId() || null;
  const doc = await Model.findOne(filter);
  if (!doc) throw new Error(`${resourceType} not found.`);
  if (!doc.isArchived) throw new Error(`${resourceType} is not archived.`);

  doc.isArchived = false;
  doc.restoredAt = new Date();
  doc.restoredBy = userId;
  doc.purgeEligibleAt = null;
  await doc.save();

  await AuditLogModel.create({
    action: "archival.restored", tenantId, requestId: resolvedCorrelationId || undefined,
    module: "EnterpriseArchival", resource: resourceType, resourceId: String(doc._id), details: {}
  });
  await publishVersionedEvent({
    eventName: "RecordRestored", version: 1, category: "Domain", owner: EVENT_OWNER, source: EVENT_OWNER,
    tenantId, correlationId: resolvedCorrelationId, data: { resourceType, resourceId: String(doc._id), restoredBy: userId }
  });

  return doc.toJSON ? doc.toJSON() : doc;
};

/**
 * "Secure Purge — Verify Retention -> Verify Legal Hold -> Management
 * Approval -> Audit Approval -> Secure Purge -> Log Purge Event." The
 * ONE place in this file an actual `deleteOne` happens, gated on every
 * one of the spec's own real checks. `approvedBy` is a required, real
 * userId — proof an approval already happened upstream (a management
 * sign-off, or a real `ApprovalWorkflowService` request completed by the
 * caller before ever reaching this function); this file does not itself
 * implement a second approval-workflow state machine — this codebase
 * already has one (`services/ApprovalWorkflowService.js`) for that.
 */
export const purgeRecord = async ({ Model, filter, resourceType, userId = null, tenantId = null, correlationId = null, approvedBy, reason = null }) => {
  if (!approvedBy) throw new Error("approvedBy is required — a secure purge must be explicitly approved.");
  const resolvedCorrelationId = correlationId || getCorrelationId() || null;

  const doc = await Model.findOne(filter).lean();
  if (!doc) throw new Error(`${resourceType} not found.`);
  if (!doc.isArchived) throw new Error(`${resourceType} must be archived before it can be purged.`);
  if (doc.legalHold) throw new Error(`${resourceType} is under legal hold and cannot be purged (${doc.legalHoldReason || "no reason on file"}).`);
  if (!doc.purgeEligibleAt || doc.purgeEligibleAt > new Date()) {
    throw new Error(`${resourceType} has not yet reached the end of its retention period${doc.purgeEligibleAt ? ` (eligible ${doc.purgeEligibleAt.toISOString()})` : ""}.`);
  }

  await publishVersionedEvent({
    eventName: "RetentionExpired", version: 1, category: "System", owner: EVENT_OWNER, source: EVENT_OWNER,
    tenantId, correlationId: resolvedCorrelationId, data: { resourceType, resourceId: String(doc._id) }
  });

  // The audit row IS the retained record once the document itself is
  // gone — "Secure Purge -> Audit Log Retained." A full snapshot, not
  // just an id, so the historical fact is genuinely reconstructable.
  await AuditLogModel.create({
    action: "archival.purged", tenantId, requestId: resolvedCorrelationId || undefined,
    module: "EnterpriseArchival", resource: resourceType, resourceId: String(doc._id),
    details: { reason, approvedBy, purgedBy: userId, snapshot: doc }
  });

  await Model.deleteOne(filter);

  await publishVersionedEvent({
    eventName: "RecordPurged", version: 1, category: "Domain", owner: EVENT_OWNER, source: EVENT_OWNER,
    tenantId, correlationId: resolvedCorrelationId, data: { resourceType, resourceId: String(doc._id), approvedBy, purgedBy: userId }
  });

  return { purged: true, resourceType, resourceId: String(doc._id) };
};
