import crypto from "crypto";
import AuditEventModel from "../models/AuditEventModel.js";
import CompliancePolicyModel from "../models/CompliancePolicyModel.js";
import DomainEventModel from "../models/DomainEventModel.js";
import JournalModel from "../models/JournalModel.js";
import InvoiceModel from "../models/InvoiceModel.js";
import AccountsPayableModel from "../models/AccountsPayableModel.js";
import ExpenseModel from "../models/ExpenseModel.js";
import RoleModel from "../models/Rolemodel.js";
import { storeDocumentPdf } from "../utils/documentPdfStorage.js";
import { publishEvent } from "../utils/eventBus.js";
import { getFinanceConfig } from "../utils/financeConfig.js";

const toCsvValue = (value) => {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return value.toISOString();
  const str = typeof value === "object" ? JSON.stringify(value) : String(value);
  return /[",\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
};

// ---------------------------------------------------------------------------
// Pure helpers — no DB access, unit-testable directly (see
// tests/auditComplianceService.test.js).
// ---------------------------------------------------------------------------

/** Real SHA-256 over an event's own evidentiary fields + the prior event's stored hash — the actual "Hash Verification"/"Checksum"/"Chain Verification" this Part's own Tamper Detection section names. Deterministic: the same inputs always produce the same hash, so `verifyChainIntegrity` can freely recompute and compare. */
export const computeEventHash = (event) => {
  const canonical = JSON.stringify({
    tenantId: event.tenantId,
    sequence: event.sequence,
    module: event.module,
    category: event.category,
    entityType: event.entityType || null,
    entityId: event.entityId || null,
    userId: event.userId || null,
    action: event.action,
    beforeState: event.beforeState ?? null,
    afterState: event.afterState ?? null,
    timestamp: new Date(event.timestamp).toISOString(),
    previousHash: event.previousHash || null
  });
  return crypto.createHash("sha256").update(canonical).digest("hex");
};

/** "Segregation of Duties... Approval Conflict." Real — the same user both created AND is among the real approvers. */
export const checkCreatorApproverConflict = (createdBy, approvers) => {
  if (!createdBy) return false;
  const list = (Array.isArray(approvers) ? approvers : [approvers]).filter(Boolean);
  return list.some((approver) => `${approver}` === `${createdBy}`);
};

/** "Segregation of Duties... Role Conflict Detection." Real — flags every real Role whose own `permissions` array grants BOTH sides of a configured conflicting pair. */
export const findRoleConflicts = (roles, conflictingPairs) => {
  const flagged = [];
  for (const role of roles) {
    const permissions = new Set(role.permissions || []);
    for (const [permA, permB] of conflictingPairs) {
      if (permissions.has(permA) && permissions.has(permB)) {
        flagged.push({ roleId: role._id, roleName: role.name, conflictingPermissions: [permA, permB] });
      }
    }
  }
  return flagged;
};

/** "Field Change Restriction" — real diff between two real state snapshots, never a fabricated one when either is missing. */
export const evaluateFieldChangeRestriction = (beforeState, afterState, restrictedFields) => {
  if (!beforeState || !afterState) return [];
  const violations = [];
  for (const field of restrictedFields || []) {
    const before = beforeState[field];
    const after = afterState[field];
    if (JSON.stringify(before) !== JSON.stringify(after)) violations.push({ field, before, after });
  }
  return violations;
};

/** Real, deterministic policy matching — no ML, no fabricated scoring. Scopes each Active policy by category/entityType, then dispatches to the one real evaluator its own `ruleType` names. */
export const evaluateCompliancePolicies = (event, policies) => {
  const violations = [];
  for (const policy of policies) {
    if (policy.categories?.length > 0 && !policy.categories.includes(event.category)) continue;
    if (policy.entityTypes?.length > 0 && event.entityType && !policy.entityTypes.includes(event.entityType)) continue;

    if (policy.ruleType === "FieldChangeRestriction") {
      for (const fv of evaluateFieldChangeRestriction(event.beforeState, event.afterState, policy.conditions?.restrictedFields || [])) {
        violations.push({ policyId: policy._id, policyName: policy.name, ruleType: policy.ruleType, description: `Restricted field "${fv.field}" changed from ${JSON.stringify(fv.before)} to ${JSON.stringify(fv.after)}.` });
      }
    }

    if (policy.ruleType === "SegregationOfDuties" && event.afterState) {
      const createdBy = event.afterState.createdBy;
      const approvers = Array.isArray(event.afterState.approvals) ? event.afterState.approvals.map((a) => a.approvedBy) : [event.afterState.approvedBy];
      if (checkCreatorApproverConflict(createdBy, approvers)) {
        violations.push({ policyId: policy._id, policyName: policy.name, ruleType: policy.ruleType, description: `The same user ("${createdBy}") both created and approved this ${event.entityType || "record"}.` });
      }
    }
  }
  return violations;
};

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

class AuditComplianceService {
  /**
   * POST /api/v1/audit-events
   * Validate Event -> Generate Hash -> Store Audit Record -> Compliance
   * Validation -> Index Event (real Mongo indexes on the model) -> Publish
   * AuditEventStored. Real per-tenant hash chain: `sequence`/`previousHash`
   * come from the real last event for this tenant; the unique
   * (tenantId, sequence) index means a concurrent write race fails loudly
   * on insert rather than silently corrupting the chain — real integrity
   * enforcement, not a fabricated distributed lock.
   */
  static async recordEvent(data, tenantId, userId) {
    const config = getFinanceConfig();
    const { module, category, entityType = null, entityId = null, action, beforeState = null, afterState = null, severity = "Info", timestamp = null, correlationId = null, requestId = null, exceptionReason = null, targetUserId = null, targetUserEmail = null, ipAddress = null, device = null } = data;

    if (!module) throw new Error("module is required.");
    if (!config.auditCategories.includes(category)) throw new Error(`Invalid category "${category}".`);
    if (!action) throw new Error("action is required.");
    const eventTimestamp = timestamp ? new Date(timestamp) : new Date();
    if (Number.isNaN(eventTimestamp.getTime())) throw new Error("Invalid timestamp.");

    const last = await AuditEventModel.findOne({ tenantId }).sort({ sequence: -1 }).select("sequence hash").lean();
    const sequence = (last?.sequence || 0) + 1;
    const previousHash = last?.hash || null;

    const hash = computeEventHash({ tenantId, sequence, module, category, entityType, entityId, userId: targetUserId, action, beforeState, afterState, timestamp: eventTimestamp, previousHash });

    const activePolicies = await CompliancePolicyModel.find({ tenantId, status: "Active" }).lean();
    const violations = evaluateCompliancePolicies({ category, entityType, beforeState, afterState }, activePolicies);
    const scopedPolicyCount = activePolicies.filter((p) => (p.categories?.length === 0 || p.categories.includes(category)) && (p.entityTypes?.length === 0 || !entityType || p.entityTypes.includes(entityType))).length;
    const complianceStatus = violations.length > 0 ? "Violation" : (exceptionReason ? "Exception" : (scopedPolicyCount > 0 ? "Compliant" : "NotEvaluated"));

    const resolvedCorrelationId = correlationId || crypto.randomUUID();

    const event = await AuditEventModel.create({
      tenantId, sequence, previousHash, hash, correlationId: resolvedCorrelationId, requestId,
      module, category, entityType, entityId, userId: targetUserId, userEmail: targetUserEmail, action, beforeState, afterState,
      severity: config.auditSeverities.includes(severity) ? severity : "Info", ipAddress, device,
      complianceStatus, complianceViolations: violations, exceptionReason,
      timestamp: eventTimestamp, performedBy: userId || null, status: "Active", legalHold: false,
      expiresAt: config.auditRetentionDays > 0 ? new Date(Date.now() + config.auditRetentionDays * 24 * 60 * 60 * 1000) : null
    });

    publishEvent("AuditEventStored", { tenantId, eventId: event._id.toString(), correlationId: resolvedCorrelationId, module, category, action, performedBy: userId || null });
    if (violations.length > 0) publishEvent("ComplianceViolationDetected", { tenantId, eventId: event._id.toString(), violations, performedBy: userId || null });
    if (exceptionReason) publishEvent("PolicyExceptionRaised", { tenantId, eventId: event._id.toString(), exceptionReason, performedBy: userId || null });

    return event.toJSON();
  }

  static async listEvents(query, tenantId) {
    const config = getFinanceConfig();
    const filter = { tenantId };
    if (query.module) filter.module = query.module;
    if (query.category) filter.category = query.category;
    if (query.entityType) filter.entityType = query.entityType;
    if (query.entityId) filter.entityId = query.entityId;
    if (query.userId) filter.userId = query.userId;
    if (query.action) filter.action = query.action;
    if (query.severity) filter.severity = query.severity;
    if (query.complianceStatus) filter.complianceStatus = query.complianceStatus;
    if (query.correlationId) filter.correlationId = query.correlationId;
    if (query.status) filter.status = query.status;
    if (query.dateFrom || query.dateTo) {
      filter.timestamp = {};
      if (query.dateFrom) filter.timestamp.$gte = new Date(query.dateFrom);
      if (query.dateTo) filter.timestamp.$lte = new Date(query.dateTo);
    }

    const page = Math.max(parseInt(query.page, 10) || 1, 1);
    const pageSize = Math.min(Math.max(parseInt(query.pageSize, 10) || config.defaultPageSize, 1), config.maxPageSize);
    const skip = (page - 1) * pageSize;

    let sortSpec = { timestamp: -1 };
    if (query.sort) {
      const direction = query.sort.startsWith("-") ? -1 : 1;
      sortSpec = { [query.sort.replace(/^-/, "")]: direction };
    }

    const [items, total] = await Promise.all([
      AuditEventModel.find(filter).sort(sortSpec).skip(skip).limit(pageSize).lean(),
      AuditEventModel.countDocuments(filter)
    ]);
    return { items, pagination: { total, page, pageSize, totalPages: Math.ceil(total / pageSize) } };
  }

  static async getEventById(eventId, tenantId) {
    const event = await AuditEventModel.findOne({ _id: eventId, tenantId }).lean();
    if (!event) throw new Error("Audit event not found.");
    return event;
  }

  /**
   * GET /api/v1/audit-events/verify-integrity — walks the real per-tenant
   * hash chain ascending, recomputing each stored hash fresh from its own
   * fields and comparing it (and each event's own `previousHash`) against
   * what's actually stored. Stops and reports the exact break point —
   * real tamper evidence, not a claimed one.
   */
  static async verifyChainIntegrity({ tenantId, fromSequence = 1, toSequence = null }) {
    const filter = { tenantId, sequence: { $gte: fromSequence } };
    if (toSequence) filter.sequence.$lte = toSequence;
    const events = await AuditEventModel.find(filter).sort({ sequence: 1 }).lean();
    if (events.length === 0) return { isValid: true, checkedCount: 0, brokenAtSequence: null };

    let expectedPreviousHash = null;
    if (fromSequence > 1) {
      const priorEvent = await AuditEventModel.findOne({ tenantId, sequence: fromSequence - 1 }).select("hash").lean();
      expectedPreviousHash = priorEvent?.hash || null;
    }

    for (let i = 0; i < events.length; i += 1) {
      const event = events[i];
      if (event.previousHash !== expectedPreviousHash) {
        const result = { isValid: false, checkedCount: i, brokenAtSequence: event.sequence, reason: "previousHash does not match the prior event's stored hash." };
        publishEvent("IntegrityCheckFailed", { tenantId, ...result });
        return result;
      }
      const recomputedHash = computeEventHash(event);
      if (recomputedHash !== event.hash) {
        const result = { isValid: false, checkedCount: i, brokenAtSequence: event.sequence, reason: "Stored hash does not match a fresh recomputation — the record may have been tampered with." };
        publishEvent("IntegrityCheckFailed", { tenantId, ...result });
        return result;
      }
      expectedPreviousHash = event.hash;
    }
    return { isValid: true, checkedCount: events.length, brokenAtSequence: null };
  }

  static async setLegalHold(eventId, tenantId, userId, legalHold) {
    const event = await AuditEventModel.findOneAndUpdate({ _id: eventId, tenantId }, { $set: { legalHold: !!legalHold, updatedBy: userId || null } }, { new: true });
    if (!event) throw new Error("Audit event not found.");
    return event.toJSON();
  }

  /** Real, cron-driven (services/auditRetentionScheduler.js) — Active, non-legal-hold events past their own `expiresAt` move to Archived. Cross-tenant, mirrors financialReportScheduler.js's own runReportExpiry pattern. */
  static async archiveExpiredEvents() {
    const now = new Date();
    const expiring = await AuditEventModel.find({ status: "Active", legalHold: false, expiresAt: { $ne: null, $lt: now } }).select("tenantId").lean();
    if (expiring.length === 0) return 0;

    const result = await AuditEventModel.updateMany({ status: "Active", legalHold: false, expiresAt: { $ne: null, $lt: now } }, { $set: { status: "Archived" } });

    const countByTenant = new Map();
    for (const e of expiring) countByTenant.set(e.tenantId, (countByTenant.get(e.tenantId) || 0) + 1);
    for (const [tenantId, archivedCount] of countByTenant) publishEvent("RetentionExpired", { tenantId, archivedCount });

    return result.modifiedCount;
  }

  static async getEntityTimeline({ tenantId, entityType, entityId }) {
    if (!entityType || !entityId) throw new Error("entityType and entityId are required.");
    return AuditEventModel.find({ tenantId, entityType, entityId }).sort({ sequence: 1 }).lean();
  }

  static async getUserActivity({ tenantId, userId, dateFrom, dateTo }) {
    if (!userId) throw new Error("userId is required.");
    const filter = { tenantId, userId };
    if (dateFrom || dateTo) {
      filter.timestamp = {};
      if (dateFrom) filter.timestamp.$gte = new Date(dateFrom);
      if (dateTo) filter.timestamp.$lte = new Date(dateTo);
    }
    return AuditEventModel.find(filter).sort({ timestamp: -1 }).limit(500).lean();
  }

  /** Real cross-source correlation — the same `correlationId` a caller supplies to `recordEvent` is also threaded through `publishEvent`'s own payload (see utils/eventBus.js), so a single ID surfaces both the audit trail AND the underlying domain events it triggered, not a fabricated join. */
  static async getCorrelatedEvents({ tenantId, correlationId }) {
    if (!correlationId) throw new Error("correlationId is required.");
    const [auditEvents, domainEvents] = await Promise.all([
      AuditEventModel.find({ tenantId, correlationId }).lean(),
      DomainEventModel.find({ tenantId, correlationId }).select("eventId eventType occurredAt payload deliveryStatus").lean()
    ]);
    return [
      ...auditEvents.map((e) => ({ source: "AuditEvent", occurredAt: e.timestamp, ...e })),
      ...domainEvents.map((e) => ({ source: "DomainEvent", occurredAt: e.occurredAt, ...e }))
    ].sort((a, b) => new Date(a.occurredAt) - new Date(b.occurredAt));
  }

  /**
   * POST /api/v1/audit-events/export — "Chain of Custody." Real CSV/JSON
   * generation + real storage (the same `storeDocumentPdf` abstraction
   * Part 24's own report exports use), and the export itself is recorded
   * as its own new AuditEventModel entry — the audit trail auditing
   * itself, not a fabricated separate custody log.
   */
  static async exportEvidence(filterQuery, format, tenantId, userId) {
    const config = getFinanceConfig();
    if (!["CSV", "JSON"].includes(format)) throw new Error(`Export format "${format}" is not supported.`);

    const filter = { tenantId };
    if (filterQuery.module) filter.module = filterQuery.module;
    if (filterQuery.category) filter.category = filterQuery.category;
    if (filterQuery.entityType) filter.entityType = filterQuery.entityType;
    if (filterQuery.entityId) filter.entityId = filterQuery.entityId;
    if (filterQuery.userId) filter.userId = filterQuery.userId;
    if (filterQuery.dateFrom || filterQuery.dateTo) {
      filter.timestamp = {};
      if (filterQuery.dateFrom) filter.timestamp.$gte = new Date(filterQuery.dateFrom);
      if (filterQuery.dateTo) filter.timestamp.$lte = new Date(filterQuery.dateTo);
    }

    const items = await AuditEventModel.find(filter).sort({ timestamp: 1 }).limit(config.auditEventMaxExportRecords).lean();

    let buffer, filename;
    if (format === "CSV") {
      const headers = ["sequence", "timestamp", "module", "category", "entityType", "entityId", "userId", "action", "severity", "complianceStatus", "hash"];
      const lines = [headers.join(","), ...items.map((e) => headers.map((h) => toCsvValue(e[h])).join(","))];
      buffer = Buffer.from(lines.join("\n"), "utf8");
      filename = `audit-evidence-${Date.now()}.csv`;
    } else {
      buffer = Buffer.from(JSON.stringify(items, null, 2), "utf8");
      filename = `audit-evidence-${Date.now()}.json`;
    }

    const stored = await storeDocumentPdf({ tenantId, folder: "audit-evidence", filename, buffer });

    const exportEvent = await AuditComplianceService.recordEvent({
      module: "Audit", category: "System", entityType: "AuditExport", entityId: null, action: "EvidenceExported",
      afterState: { format, recordCount: items.length, url: stored.url, filter: filterQuery }, severity: "Info"
    }, tenantId, userId);

    publishEvent("EvidenceArchived", { tenantId, exportEventId: exportEvent._id, url: stored.url, recordCount: items.length, performedBy: userId || null });

    return { format, url: stored.url, storageKey: stored.storageKey, storageProvider: stored.storageProvider, recordCount: items.length, exportEventId: exportEvent._id };
  }

  /**
   * Real, on-demand entity-level Segregation of Duties check — fetches
   * the ACTUAL live entity from its own real model (only the entity
   * types whose real approver field shape has been verified — see
   * utils/financeConfig.js's own `sodSupportedEntityTypes` doc comment).
   */
  static async checkSegregationOfDuties({ tenantId, entityType, entityId }) {
    const config = getFinanceConfig();
    if (!config.sodSupportedEntityTypes.includes(entityType)) throw new Error(`Segregation of Duties check is not yet supported for entityType "${entityType}".`);

    let createdBy, approvers;
    if (entityType === "Journal") {
      const doc = await JournalModel.findOne({ _id: entityId, tenantId }).select("createdBy approvedBy").lean();
      if (!doc) throw new Error("Journal not found.");
      createdBy = doc.createdBy; approvers = [doc.approvedBy];
    } else if (entityType === "Invoice") {
      const doc = await InvoiceModel.findOne({ _id: entityId, tenantId }).select("createdBy approvedBy").lean();
      if (!doc) throw new Error("Invoice not found.");
      createdBy = doc.createdBy; approvers = [doc.approvedBy];
    } else if (entityType === "AccountsPayable") {
      const doc = await AccountsPayableModel.findOne({ _id: entityId, tenantId }).select("createdBy approvedBy").lean();
      if (!doc) throw new Error("Accounts Payable record not found.");
      createdBy = doc.createdBy; approvers = [doc.approvedBy];
    } else if (entityType === "Expense") {
      const doc = await ExpenseModel.findOne({ _id: entityId, tenantId }).select("createdBy approvals").lean();
      if (!doc) throw new Error("Expense not found.");
      createdBy = doc.createdBy; approvers = (doc.approvals || []).map((a) => a.approvedBy);
    }

    return { entityType, entityId, createdBy, approvers, hasConflict: checkCreatorApproverConflict(createdBy, approvers), checkedAt: new Date() };
  }

  static async checkRoleConflicts({ tenantId, conflictingPairs = null }) {
    const config = getFinanceConfig();
    const pairs = conflictingPairs && conflictingPairs.length > 0 ? conflictingPairs : config.sodConflictingPermissionPairs;
    const roles = await RoleModel.find({ tenantId, status: "active" }).select("name permissions").lean();
    return findRoleConflicts(roles, pairs);
  }

  static async createPolicy(data, tenantId, userId) {
    const config = getFinanceConfig();
    const { name, description = null, policyType, ruleType, conditions = {}, categories = [], entityTypes = [], severity = "Warning" } = data;
    if (!name) throw new Error("name is required.");
    if (!config.compliancePolicyTypes.includes(policyType)) throw new Error(`Invalid policyType "${policyType}".`);
    if (!config.complianceRuleTypes.includes(ruleType)) throw new Error(`Invalid ruleType "${ruleType}".`);

    const policy = await CompliancePolicyModel.create({ tenantId, name, description, policyType, ruleType, conditions, categories, entityTypes, severity, status: "Active", createdBy: userId || null, updatedBy: userId || null });
    return policy.toJSON();
  }

  static async listPolicies(query, tenantId) {
    const filter = { tenantId };
    if (query.status) filter.status = query.status;
    if (query.ruleType) filter.ruleType = query.ruleType;
    return CompliancePolicyModel.find(filter).sort({ createdAt: -1 }).lean();
  }

  static async updatePolicyStatus(policyId, tenantId, userId, status) {
    if (!["Active", "Inactive"].includes(status)) throw new Error(`Invalid status "${status}".`);
    const policy = await CompliancePolicyModel.findOneAndUpdate({ _id: policyId, tenantId }, { $set: { status, updatedBy: userId || null } }, { new: true });
    if (!policy) throw new Error("Compliance policy not found.");
    return policy.toJSON();
  }
}

export default AuditComplianceService;
