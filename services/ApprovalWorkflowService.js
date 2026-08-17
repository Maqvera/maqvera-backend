import crypto from "crypto";
import ApprovalWorkflowDefinitionModel from "../models/ApprovalWorkflowDefinitionModel.js";
import ApprovalRequestModel from "../models/ApprovalRequestModel.js";
import ApprovalDelegationModel from "../models/ApprovalDelegationModel.js";
import UserModel from "../models/Usermodel.js";
import RoleModel from "../models/Rolemodel.js";
import CustomerModel from "../models/CustomerModel.js";
import AuditLogModel from "../models/AuditLogmodel.js";
import { getDeliveryAdapter } from "./delivery/index.js";
import { resolveContactForMethod } from "./ReceiptService.js";
import { publishEvent } from "../utils/eventBus.js";
import { getFinanceConfig } from "../utils/financeConfig.js";

// ---------------------------------------------------------------------------
// Pure helpers — no DB access, unit-testable directly (see
// tests/approvalWorkflowService.test.js).
// ---------------------------------------------------------------------------

export const isWorkflowDefinitionApprovable = (status) => status === "Draft";
export const isWorkflowDefinitionArchivable = (status) => ["Draft", "Approved", "Expired"].includes(status);

/**
 * "Approval Rules: Amount, Department, Country, Customer Type." Real
 * operators only — `branch`/`riskScore`/`businessUnit`/`project`/
 * `vendorType` are dropped/deferred (no real risk-scoring, business-unit,
 * project, or vendor-type field exists anywhere in this codebase to
 * evaluate them against honestly). An empty/missing `conditions` object
 * always matches (a condition-free workflow applies universally within
 * its module).
 */
export const evaluateConditions = (conditions, context) => {
  if (!conditions || typeof conditions !== "object") return true;
  const c = context || {};
  if (conditions.amountGreaterThan !== undefined && !(c.amount > conditions.amountGreaterThan)) return false;
  if (conditions.amountGreaterThanOrEqual !== undefined && !(c.amount >= conditions.amountGreaterThanOrEqual)) return false;
  if (conditions.amountLessThan !== undefined && !(c.amount < conditions.amountLessThan)) return false;
  if (conditions.amountLessThanOrEqual !== undefined && !(c.amount <= conditions.amountLessThanOrEqual)) return false;
  if (conditions.department !== undefined && conditions.department !== null && String(c.department || "") !== String(conditions.department)) return false;
  if (conditions.country !== undefined && conditions.country !== null && String(c.country || "").toUpperCase() !== String(conditions.country).toUpperCase()) return false;
  if (conditions.customerType !== undefined && conditions.customerType !== null && String(c.customerType || "") !== String(conditions.customerType)) return false;
  return true;
};

/** Resolves a Conditional definition's own `branches` (first match wins) into a concrete {approvalType, levels}; a non-Conditional definition just returns its own top-level fields unchanged. */
export const resolveBranch = (definition, context) => {
  if (definition.approvalType !== "Conditional") return { approvalType: definition.approvalType, levels: definition.levels };
  const branch = (definition.branches || []).find((b) => evaluateConditions(b.conditions, context));
  if (!branch) throw new Error(`No matching branch for workflow "${definition.name}" given the supplied context.`);
  return { approvalType: branch.approvalType, levels: branch.levels };
};

/** Real SHA-256 digital signature — independently reproducible given the same inputs. See ApprovalRequestModel's own doc comment for the "Certificate Validation" scope boundary. */
export const computeSignatureHash = ({ requestId, levelIndex, approverId, decision, timestamp }) => {
  const payload = `${requestId}|${levelIndex}|${approverId}|${decision}|${new Date(timestamp).toISOString()}`;
  return crypto.createHash("sha256").update(payload).digest("hex");
};

/**
 * The real completion engine — given a resolved request's own `levels`
 * (flattened approver sets) and `decisions` so far, returns
 * `{ complete: boolean, outcome: 'Approved'|'Rejected'|null, nextLevelIndex }`.
 * "Approval Types: Sequential, Parallel, Any One, All Required, Majority
 * Vote" — each has real, distinct semantics:
 * - Sequential: only the CURRENT level's assigned approvers may decide;
 *   a level needs `minApprovals` distinct 'Approved' decisions to
 *   advance; any 'Rejected' at any level rejects the whole request.
 * - Parallel: every level's approvers are eligible from the start; the
 *   request completes once EVERY level independently reaches its own
 *   `minApprovals`; any 'Rejected' anywhere rejects the whole request.
 * - AnyOne: any single 'Approved' from any assigned approver (across all
 *   levels, flattened) completes the request immediately; it only
 *   rejects if every assigned approver has rejected.
 * - AllRequired: every assigned approver (flattened) must decide
 *   'Approved'; any single 'Rejected' rejects the whole request.
 * - MajorityVote: strict majority (> half) of all assigned approvers
 *   (flattened) deciding 'Approved' completes it; strict majority
 *   deciding 'Rejected' rejects it.
 */
export const evaluateApprovalProgress = (approvalType, levels, decisions) => {
  const approvedBy = new Set(decisions.filter((d) => d.decision === "Approved").map((d) => d.approverId.toString()));
  const rejectedBy = new Set(decisions.filter((d) => d.decision === "Rejected").map((d) => d.approverId.toString()));

  if (approvalType === "Sequential") {
    if (rejectedBy.size > 0) return { complete: true, outcome: "Rejected", nextLevelIndex: null };
    for (let i = 0; i < levels.length; i += 1) {
      const level = levels[i];
      const levelApprovers = new Set(level.approverUserIds.map((id) => id.toString()));
      const levelApprovedCount = [...approvedBy].filter((id) => levelApprovers.has(id)).length;
      const required = level.minApprovals || levelApprovers.size;
      if (levelApprovedCount < required) return { complete: false, outcome: null, nextLevelIndex: i };
    }
    return { complete: true, outcome: "Approved", nextLevelIndex: null };
  }

  if (approvalType === "Parallel") {
    if (rejectedBy.size > 0) return { complete: true, outcome: "Rejected", nextLevelIndex: null };
    const allSatisfied = levels.every((level) => {
      const levelApprovers = new Set(level.approverUserIds.map((id) => id.toString()));
      const levelApprovedCount = [...approvedBy].filter((id) => levelApprovers.has(id)).length;
      return levelApprovedCount >= (level.minApprovals || levelApprovers.size);
    });
    return allSatisfied ? { complete: true, outcome: "Approved", nextLevelIndex: null } : { complete: false, outcome: null, nextLevelIndex: null };
  }

  const allApproverIds = new Set(levels.flatMap((l) => l.approverUserIds.map((id) => id.toString())));

  if (approvalType === "AnyOne") {
    if (approvedBy.size > 0) return { complete: true, outcome: "Approved", nextLevelIndex: null };
    if (rejectedBy.size >= allApproverIds.size && allApproverIds.size > 0) return { complete: true, outcome: "Rejected", nextLevelIndex: null };
    return { complete: false, outcome: null, nextLevelIndex: null };
  }

  if (approvalType === "AllRequired") {
    if (rejectedBy.size > 0) return { complete: true, outcome: "Rejected", nextLevelIndex: null };
    if (approvedBy.size >= allApproverIds.size && allApproverIds.size > 0) return { complete: true, outcome: "Approved", nextLevelIndex: null };
    return { complete: false, outcome: null, nextLevelIndex: null };
  }

  if (approvalType === "MajorityVote") {
    const total = allApproverIds.size;
    if (total === 0) return { complete: false, outcome: null, nextLevelIndex: null };
    if (approvedBy.size > total / 2) return { complete: true, outcome: "Approved", nextLevelIndex: null };
    if (rejectedBy.size > total / 2) return { complete: true, outcome: "Rejected", nextLevelIndex: null };
    return { complete: false, outcome: null, nextLevelIndex: null };
  }

  throw new Error(`Unknown approvalType "${approvalType}".`);
};

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

class ApprovalWorkflowService {
  // ---- Workflow Definitions ----

  /**
   * POST /api/v1/approval-workflows
   * Validate Workflow -> Validate Conditions -> Approval Workflow ->
   * Activate Definition -> Audit -> Publish WorkflowCreated. "Immutable
   * Workflow History" — mirrors Part 20/21's own auto-supersede exactly,
   * keyed by `name`.
   */
  static async createWorkflowDefinition(data, tenantId, userId) {
    const config = getFinanceConfig();
    const { name, description = null, module, conditions = {}, approvalType, levels = [], branches = [], slaHours = null, escalation = {}, effectiveDate } = data;

    if (!name || !module || !approvalType || !effectiveDate) throw new Error("name, module, approvalType, and effectiveDate are required.");
    if (!config.workflowModules.includes(module)) throw new Error(`Invalid module "${module}".`);
    if (!config.approvalTypes.includes(approvalType)) throw new Error(`Invalid approvalType "${approvalType}".`);
    if (approvalType === "Conditional") {
      if (!Array.isArray(branches) || branches.length === 0) throw new Error("branches is required (and must be non-empty) when approvalType is Conditional.");
      for (const branch of branches) {
        if (!config.approvalTypes.includes(branch.approvalType) || branch.approvalType === "Conditional") throw new Error(`Invalid branch approvalType "${branch.approvalType}".`);
        if (!Array.isArray(branch.levels) || branch.levels.length === 0) throw new Error("Each branch requires at least one level.");
      }
    } else if (!Array.isArray(levels) || levels.length === 0) {
      throw new Error("levels is required (and must be non-empty) unless approvalType is Conditional.");
    }
    for (const level of [...levels, ...branches.flatMap((b) => b.levels || [])]) {
      if (!["Role", "User"].includes(level.approverType)) throw new Error(`Invalid approverType "${level.approverType}" on level "${level.levelName}".`);
      if (level.approverType === "Role" && !level.approverPermissionKey) throw new Error(`Level "${level.levelName}" requires approverPermissionKey when approverType is Role.`);
      if (level.approverType === "User" && !level.approverUserId) throw new Error(`Level "${level.levelName}" requires approverUserId when approverType is User.`);
    }

    const effDate = new Date(effectiveDate);
    const duplicate = await ApprovalWorkflowDefinitionModel.findOne({ tenantId, name, effectiveDate: effDate }).lean();
    if (duplicate) throw new Error(`A workflow definition named "${name}" already exists with effectiveDate ${effDate.toISOString().slice(0, 10)}.`);

    const definition = new ApprovalWorkflowDefinitionModel({
      tenantId, name, description, module, conditions, approvalType, levels, branches, slaHours,
      escalation: { enabled: !!escalation.enabled, afterHours: escalation.afterHours || null, escalateToPermissionKey: escalation.escalateToPermissionKey || null },
      effectiveDate: effDate, status: config.defaultWorkflowDefinitionStatus,
      timeline: [{ event: "WorkflowCreated", description: `${module} workflow "${name}" created.`, performedBy: userId || null }],
      createdBy: userId || null, updatedBy: userId || null
    });

    if (!config.workflowDefinitionApprovalRequired) {
      definition.status = "Approved";
      definition.timeline.push({ event: "WorkflowDefinitionApproved", description: "Auto-approved — approval is not required.", performedBy: "system" });
    }
    await definition.save();

    let supersededDefinitionId = null;
    if (definition.status === "Approved") {
      const priorOpenEnded = await ApprovalWorkflowDefinitionModel.findOne({ tenantId, name, status: "Approved", _id: { $ne: definition._id }, endDate: null, effectiveDate: { $lt: effDate } });
      if (priorOpenEnded) {
        const closeDate = new Date(effDate);
        closeDate.setUTCDate(closeDate.getUTCDate() - 1);
        priorOpenEnded.endDate = closeDate;
        priorOpenEnded.status = "Superseded";
        priorOpenEnded.timeline.push({ event: "WorkflowDefinitionSuperseded", description: `Superseded by the version effective ${effDate.toISOString().slice(0, 10)}.`, performedBy: userId || null });
        await priorOpenEnded.save();
        definition.supersedes = priorOpenEnded._id;
        await definition.save();
        supersededDefinitionId = priorOpenEnded._id.toString();
      }
    }

    await AuditLogModel.create({ action: "finance.approvalworkflow.create_definition", module: "Finance", resource: "ApprovalWorkflowDefinition", resourceId: definition._id.toString(), userId: userId || null, tenantId, details: { name, module, supersededDefinitionId } });
    publishEvent("WorkflowCreated", { tenantId, workflowDefinitionId: definition._id.toString(), name, module, performedBy: userId || null });

    return definition.toJSON();
  }

  static async listWorkflowDefinitions(query, tenantId) {
    const filter = { tenantId };
    if (query.module) filter.module = query.module;
    if (query.status) filter.status = query.status;
    return ApprovalWorkflowDefinitionModel.find(filter).sort({ effectiveDate: -1 }).lean();
  }

  static async getWorkflowDefinitionById(definitionId, tenantId) {
    const definition = await ApprovalWorkflowDefinitionModel.findOne({ _id: definitionId, tenantId }).lean();
    if (!definition) throw new Error("Workflow definition not found.");
    return definition;
  }

  static async approveWorkflowDefinition(definitionId, tenantId, userId) {
    const definition = await ApprovalWorkflowDefinitionModel.findOne({ _id: definitionId, tenantId });
    if (!definition) throw new Error("Workflow definition not found.");
    if (!isWorkflowDefinitionApprovable(definition.status)) throw new Error(`Workflow definition cannot be approved from status "${definition.status}".`);

    definition.status = "Approved";
    definition.updatedBy = userId || null;
    definition.timeline.push({ event: "WorkflowDefinitionApproved", description: "Workflow definition approved.", performedBy: userId || null });
    await definition.save();

    await AuditLogModel.create({ action: "finance.approvalworkflow.approve_definition", module: "Finance", resource: "ApprovalWorkflowDefinition", resourceId: definition._id.toString(), userId: userId || null, tenantId, details: {} });

    return definition.toJSON();
  }

  static async archiveWorkflowDefinition(definitionId, tenantId, userId) {
    const definition = await ApprovalWorkflowDefinitionModel.findOne({ _id: definitionId, tenantId });
    if (!definition) throw new Error("Workflow definition not found.");
    if (!isWorkflowDefinitionArchivable(definition.status)) throw new Error(`Workflow definition cannot be archived from status "${definition.status}".`);

    definition.status = "Archived";
    definition.updatedBy = userId || null;
    definition.timeline.push({ event: "WorkflowDefinitionArchived", description: "Workflow definition archived.", performedBy: userId || null });
    await definition.save();

    await AuditLogModel.create({ action: "finance.approvalworkflow.archive_definition", module: "Finance", resource: "ApprovalWorkflowDefinition", resourceId: definition._id.toString(), userId: userId || null, tenantId, details: {} });

    return definition.toJSON();
  }

  static async _resolveDefinition(tenantId, module, context, asOfDate) {
    const candidates = await ApprovalWorkflowDefinitionModel.find({
      tenantId, module, status: "Approved", effectiveDate: { $lte: asOfDate }, $or: [{ endDate: null }, { endDate: { $gte: asOfDate } }]
    }).sort({ effectiveDate: -1 }).lean();
    return candidates.find((d) => evaluateConditions(d.conditions, context)) || null;
  }

  /**
   * Real, permission-based approver resolution — matches this codebase's
   * actual RBAC model (`RoleModel.permissions` -> `UserModel.role`),
   * never a hardcoded role-name allowlist (the exact anti-pattern
   * `tests/accessScopeRegression.test.js` already guards this codebase
   * against elsewhere).
   */
  static async _resolveApproversForLevel(level, tenantId) {
    if (level.approverType === "User") return level.approverUserId ? [level.approverUserId] : [];
    // "admin" always counts as eligible for any permission-gated level —
    // the same universal override every controller's own hasPermission()
    // helper already grants throughout this codebase.
    const roles = await RoleModel.find({ tenantId, status: "active", permissions: { $in: [level.approverPermissionKey, "admin"] } }).select("name").lean();
    if (roles.length === 0) return [];
    const roleNames = roles.map((r) => r.name);
    const users = await UserModel.find({ tenantId, role: { $in: roleNames }, status: "active" }).select("_id").lean();
    return users.map((u) => u._id);
  }

  static async _sendNotification(userId, tenantId, { subject, body }) {
    const config = getFinanceConfig();
    const user = await UserModel.findOne({ _id: userId, tenantId }).lean();
    if (!user) return { status: "Failed", failureReason: "User not found." };
    const adapter = getDeliveryAdapter(config.defaultApprovalNotificationChannel);
    if (!adapter) return { status: "NotConfigured", failureReason: `No delivery adapter for "${config.defaultApprovalNotificationChannel}".` };
    const to = resolveContactForMethod(config.defaultApprovalNotificationChannel, user);
    if (!to) return { status: "Failed", failureReason: "No contact information available." };
    return adapter.send({ to, subject, body, receiptNumber: null, verificationUrl: null });
  }

  // ---- Approval Requests ----

  /**
   * POST /api/v1/approvals/start
   * Resolve Workflow -> Determine Approvers -> Create Approval Tasks ->
   * Send Notifications -> Wait For Decisions -> Return Tracking ID.
   */
  static async startApproval(data, tenantId, userId) {
    const { module, entityId, entityRef = null, context = {}, asOfDate } = data;
    if (!module || !entityId) throw new Error("module and entityId are required.");

    const date = asOfDate ? new Date(asOfDate) : new Date();
    const definition = await ApprovalWorkflowService._resolveDefinition(tenantId, module, context, date);
    if (!definition) throw new Error(`No active approval workflow found for module "${module}" matching the supplied context.`);

    const { approvalType, levels: rawLevels } = resolveBranch(definition, context);

    const resolvedLevels = [];
    for (const level of rawLevels) {
      const approverUserIds = await ApprovalWorkflowService._resolveApproversForLevel(level, tenantId);
      const slaHours = level.slaHours || definition.slaHours || getFinanceConfig().defaultApprovalSlaHours;
      resolvedLevels.push({
        levelName: level.levelName, order: level.order, approverUserIds, minApprovals: level.minApprovals || approverUserIds.length || 1,
        slaHours, slaDeadline: new Date(date.getTime() + slaHours * 60 * 60 * 1000)
      });
    }
    resolvedLevels.sort((a, b) => a.order - b.order);

    const request = await ApprovalRequestModel.create({
      tenantId, module, entityId, entityRef, workflowDefinitionId: definition._id, workflowDefinitionName: definition.name,
      approvalType, levels: resolvedLevels, status: "Pending", context, requestedBy: userId || null, requestedAt: date,
      timeline: [{ event: "ApprovalStarted", description: `Approval started via workflow "${definition.name}".`, performedBy: userId || null }]
    });

    await AuditLogModel.create({ action: "finance.approvalworkflow.start", module: "Finance", resource: "ApprovalRequest", resourceId: request._id.toString(), userId: userId || null, tenantId, details: { module, entityId: entityId.toString(), workflowDefinitionId: definition._id.toString() } });
    publishEvent("ApprovalStarted", { tenantId, approvalId: request._id.toString(), module, entityId: entityId.toString(), performedBy: userId || null });

    // "Determine Approvers -> Create Approval Tasks -> Send
    // Notifications." Notifies the first eligible level(s) — every level
    // for Parallel/AnyOne/AllRequired/MajorityVote (all are eligible
    // immediately), only the first level for Sequential.
    const levelsToNotify = approvalType === "Sequential" ? resolvedLevels.slice(0, 1) : resolvedLevels;
    for (const level of levelsToNotify) {
      for (const approverId of level.approverUserIds) {
        await ApprovalWorkflowService._sendNotification(approverId, tenantId, { subject: `Approval Required: ${module} (${level.levelName})`, body: `A ${module} request (${entityRef || entityId}) requires your ${level.levelName} approval.` });
      }
      if (level.approverUserIds.length > 0) publishEvent("ApprovalAssigned", { tenantId, approvalId: request._id.toString(), levelName: level.levelName, approverIds: level.approverUserIds.map((id) => id.toString()), performedBy: userId || null });
    }

    return request.toJSON();
  }

  static async listApprovalRequests(query, tenantId) {
    const config = getFinanceConfig();
    const filter = { tenantId };
    if (query.module) filter.module = query.module;
    if (query.status) filter.status = query.status;
    if (query.entityId) filter.entityId = query.entityId;

    const page = Math.max(parseInt(query.page, 10) || 1, 1);
    const pageSize = Math.min(Math.max(parseInt(query.pageSize, 10) || config.defaultPageSize, 1), config.maxPageSize);
    const skip = (page - 1) * pageSize;

    const [items, total] = await Promise.all([
      ApprovalRequestModel.find(filter).sort({ requestedAt: -1 }).skip(skip).limit(pageSize).lean(),
      ApprovalRequestModel.countDocuments(filter)
    ]);
    return { items, pagination: { total, page, pageSize, totalPages: Math.ceil(total / pageSize) } };
  }

  static async getApprovalRequestById(approvalId, tenantId) {
    const request = await ApprovalRequestModel.findOne({ _id: approvalId, tenantId }).lean();
    if (!request) throw new Error("Approval request not found.");
    return request;
  }

  /**
   * POST /api/v1/approvals/{approvalId}/decision
   * Validate Permission -> Record Decision -> Check Remaining Approvals
   * -> Continue Workflow -> Complete Workflow -> Publish
   * ApprovalCompleted. Redirects through an Active
   * `ApprovalDelegationModel` when the caller isn't an assigned approver
   * themselves but IS the active delegate for one who is.
   */
  static async recordDecision(approvalId, data, tenantId, userId) {
    const { decision, comments = null } = data;
    if (!["Approved", "Rejected"].includes(decision)) throw new Error('decision must be "Approved" or "Rejected".');

    const request = await ApprovalRequestModel.findOne({ _id: approvalId, tenantId });
    if (!request) throw new Error("Approval request not found.");
    if (request.status !== "Pending" && request.status !== "Escalated") throw new Error(`Approval request cannot receive a decision in status "${request.status}".`);

    const now = new Date();
    let actingApproverId = userId;
    let decidedOnBehalfOf = null;

    const isDirectlyAssigned = request.levels.some((l) => l.approverUserIds.some((id) => id.toString() === String(userId)));
    if (!isDirectlyAssigned) {
      const delegation = await ApprovalDelegationModel.findOne({
        tenantId, delegateUserId: userId, status: "Active", validFrom: { $lte: now }, $or: [{ validUntil: null }, { validUntil: { $gte: now } }],
        $and: [{ $or: [{ module: null }, { module: request.module }] }]
      }).lean();
      if (!delegation) throw new Error("You are not an assigned approver for this request (and hold no active delegation for it).");
      const delegatorIsAssigned = request.levels.some((l) => l.approverUserIds.some((id) => id.toString() === delegation.delegatorUserId.toString()));
      if (!delegatorIsAssigned) throw new Error("Your delegator is not an assigned approver for this request.");
      actingApproverId = delegation.delegatorUserId;
      decidedOnBehalfOf = userId;
      publishEvent("ApprovalDelegated", { tenantId, approvalId: request._id.toString(), delegateUserId: userId.toString(), delegatorUserId: actingApproverId.toString(), performedBy: userId });
    }

    if (request.approvalType === "Sequential") {
      const currentLevel = request.levels[request.currentLevelIndex];
      if (!currentLevel || !currentLevel.approverUserIds.some((id) => id.toString() === actingApproverId.toString())) {
        throw new Error(`It is not currently this approver's turn (current level: "${currentLevel?.levelName || "none"}").`);
      }
    }

    const levelIndex = request.levels.findIndex((l) => l.approverUserIds.some((id) => id.toString() === actingApproverId.toString()));
    if (request.decisions.some((d) => d.approverId.toString() === actingApproverId.toString() && d.levelIndex === levelIndex)) {
      throw new Error("This approver has already recorded a decision for this level.");
    }

    const signatureHash = computeSignatureHash({ requestId: request._id.toString(), levelIndex, approverId: actingApproverId.toString(), decision, timestamp: now });
    request.decisions.push({ levelIndex, approverId: actingApproverId, decidedOnBehalfOf, decision, comments, signatureHash, decidedAt: now });
    request.timeline.push({ event: decision === "Approved" ? "ApprovalApproved" : "ApprovalRejected", description: `${request.levels[levelIndex]?.levelName || "Level"}: ${decision}${comments ? ` — ${comments}` : ""}.`, performedBy: userId });
    await request.save();

    publishEvent(decision === "Approved" ? "ApprovalApproved" : "ApprovalRejected", { tenantId, approvalId: request._id.toString(), levelIndex, approverId: actingApproverId.toString(), performedBy: userId });

    const progress = evaluateApprovalProgress(request.approvalType, request.levels, request.decisions);

    if (!progress.complete) {
      if (request.approvalType === "Sequential" && progress.nextLevelIndex !== request.currentLevelIndex) {
        request.currentLevelIndex = progress.nextLevelIndex;
        const nextLevel = request.levels[progress.nextLevelIndex];
        await request.save();
        for (const approverId of nextLevel.approverUserIds) {
          await ApprovalWorkflowService._sendNotification(approverId, tenantId, { subject: `Approval Required: ${request.module} (${nextLevel.levelName})`, body: `A ${request.module} request (${request.entityRef || request.entityId}) requires your ${nextLevel.levelName} approval.` });
        }
        publishEvent("ApprovalAssigned", { tenantId, approvalId: request._id.toString(), levelName: nextLevel.levelName, approverIds: nextLevel.approverUserIds.map((id) => id.toString()), performedBy: "system" });
      }
      return request.toJSON();
    }

    request.status = progress.outcome;
    request.completedAt = now;
    request.timeline.push({ event: "WorkflowCompleted", description: `Workflow completed: ${progress.outcome}.`, performedBy: userId });
    await request.save();

    await AuditLogModel.create({ action: "finance.approvalworkflow.decision", module: "Finance", resource: "ApprovalRequest", resourceId: request._id.toString(), userId, tenantId, details: { decision, outcome: progress.outcome } });
    if (progress.outcome === "Approved") publishEvent("WorkflowCompleted", { tenantId, approvalId: request._id.toString(), module: request.module, entityId: request.entityId.toString(), performedBy: userId });

    return request.toJSON();
  }

  static async cancelApprovalRequest(approvalId, data, tenantId, userId) {
    const request = await ApprovalRequestModel.findOne({ _id: approvalId, tenantId });
    if (!request) throw new Error("Approval request not found.");
    if (!["Pending", "Escalated"].includes(request.status)) throw new Error(`Approval request cannot be cancelled from status "${request.status}".`);

    request.status = "Cancelled";
    request.cancelledBy = userId || null;
    request.cancelledAt = new Date();
    request.cancellationReason = data?.reason || null;
    request.timeline.push({ event: "WorkflowCancelled", description: data?.reason || "Approval request cancelled.", performedBy: userId || null });
    await request.save();

    await AuditLogModel.create({ action: "finance.approvalworkflow.cancel", module: "Finance", resource: "ApprovalRequest", resourceId: request._id.toString(), userId: userId || null, tenantId, details: { reason: data?.reason || null } });
    publishEvent("WorkflowCancelled", { tenantId, approvalId: request._id.toString(), performedBy: userId || null });

    return request.toJSON();
  }

  // ---- Delegation ----

  static async createDelegation(data, tenantId, userId) {
    const config = getFinanceConfig();
    const { delegatorUserId, delegateUserId, delegationType, module = null, validFrom, validUntil = null, reason = null } = data;
    if (!delegatorUserId || !delegateUserId || !delegationType || !validFrom) throw new Error("delegatorUserId, delegateUserId, delegationType, and validFrom are required.");
    if (!config.delegationTypes.includes(delegationType)) throw new Error(`Invalid delegationType "${delegationType}".`);
    if (module && !config.workflowModules.includes(module)) throw new Error(`Invalid module "${module}".`);
    if (delegationType === "Permanent" && validUntil) throw new Error("A Permanent delegation cannot have a validUntil date.");

    const delegation = await ApprovalDelegationModel.create({
      tenantId, delegatorUserId, delegateUserId, delegationType, module, validFrom: new Date(validFrom),
      validUntil: validUntil ? new Date(validUntil) : null, reason, status: "Active", createdBy: userId || null, updatedBy: userId || null
    });

    await AuditLogModel.create({ action: "finance.approvalworkflow.create_delegation", module: "Finance", resource: "ApprovalDelegation", resourceId: delegation._id.toString(), userId: userId || null, tenantId, details: { delegatorUserId: delegatorUserId.toString(), delegateUserId: delegateUserId.toString(), delegationType } });

    return delegation.toJSON();
  }

  static async listDelegations(query, tenantId) {
    const filter = { tenantId };
    if (query.delegatorUserId) filter.delegatorUserId = query.delegatorUserId;
    if (query.status) filter.status = query.status;
    return ApprovalDelegationModel.find(filter).sort({ createdAt: -1 }).lean();
  }

  static async revokeDelegation(delegationId, tenantId, userId) {
    const delegation = await ApprovalDelegationModel.findOne({ _id: delegationId, tenantId });
    if (!delegation) throw new Error("Delegation not found.");
    if (delegation.status !== "Active") throw new Error(`Delegation cannot be revoked from status "${delegation.status}".`);

    delegation.status = "Revoked";
    delegation.updatedBy = userId || null;
    await delegation.save();

    await AuditLogModel.create({ action: "finance.approvalworkflow.revoke_delegation", module: "Finance", resource: "ApprovalDelegation", resourceId: delegation._id.toString(), userId: userId || null, tenantId, details: {} });

    return delegation.toJSON();
  }

  // ---- Cross-module bridge (see docs/05-api/07-finance-api.md Part 22) ----

  /**
   * The real "every module should ask a centralized [...] Engine" bridge
   * — resolves the ordered level-name list a module's own state machine
   * needs (e.g. `["Manager", "Finance", "CFO"]`) from a real, versioned
   * `ApprovalWorkflowDefinitionModel`, when one exists for that module;
   * returns `null` when none matches, so the caller can fall back to its
   * own pre-existing config-driven computation (see
   * `ExpenseService.submitExpense`'s own use of this).
   */
  static async resolveApprovalLevels(module, context, tenantId, asOfDate = new Date()) {
    const definition = await ApprovalWorkflowService._resolveDefinition(tenantId, module, context, asOfDate);
    if (!definition) return null;
    const { levels } = resolveBranch(definition, context);
    return [...levels].sort((a, b) => a.order - b.order).map((l) => l.levelName);
  }
}

export default ApprovalWorkflowService;
