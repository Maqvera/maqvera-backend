import { subscribeEvent } from "../utils/eventBus.js";
import InAppNotificationService from "./InAppNotificationService.js";
import ApprovalRequestModel from "../models/ApprovalRequestModel.js";
import AIApprovalRequestModel from "../models/AIApprovalRequestModel.js";
import RoleModel from "../models/Rolemodel.js";
import UserModel from "../models/Usermodel.js";
import logger from "../utils/logger.js";

/**
 * Enterprise In-App Notification Platform (Part 6) — highest-value first
 * consumer. Approval workflows already exist (ApprovalWorkflowService,
 * AIOrchestrationService's AI-tool human-approval gate) and already publish
 * real domain events (ApprovalAssigned/ApprovalRejected/WorkflowCompleted,
 * AIApprovalRequested/AIApprovalGranted/AIApprovalRejected) — this was
 * purely an "event exists, nobody listens" gap for the in-app channel
 * specifically (ApprovalWorkflowService._sendNotification already sends an
 * out-of-band email; there was no live, actionable inbox item), the same
 * class of gap VisaCommunicationListener.js closed for Visa/WhatsApp.
 *
 * Every handler is best-effort: creating the in-app notification never
 * blocks or fails the approval action that already genuinely happened —
 * logged and swallowed on error, same contract as every other event-bus
 * listener in this codebase.
 */
class ApprovalNotificationListener {
  static _initialized = false;

  static initEventListeners() {
    if (ApprovalNotificationListener._initialized) return;
    ApprovalNotificationListener._initialized = true;

    // Finance/module Approval Workflow (ApprovalWorkflowService).
    subscribeEvent("ApprovalAssigned", (payload) => ApprovalNotificationListener._handleApprovalAssigned(payload));
    // Any single "Rejected" decision is always immediately terminal
    // (evaluateApprovalProgress), for both Sequential and Parallel
    // workflows — safe to treat every ApprovalRejected as the final outcome.
    subscribeEvent("ApprovalRejected", (payload) => ApprovalNotificationListener._handleApprovalOutcome(payload, "Rejected"));
    // WorkflowCompleted is only published for the Approved outcome (see
    // ApprovalWorkflowService.decideApproval) — Rejected is covered above.
    subscribeEvent("WorkflowCompleted", (payload) => ApprovalNotificationListener._handleApprovalOutcome(payload, "Approved"));

    // AI Agent human-approval gate (AIToolRegistry/AIOrchestrationService).
    subscribeEvent("AIApprovalRequested", (payload) => ApprovalNotificationListener._handleAIApprovalRequested(payload));
    subscribeEvent("AIApprovalGranted", (payload) => ApprovalNotificationListener._handleAIApprovalOutcome(payload, "Approved"));
    subscribeEvent("AIApprovalRejected", (payload) => ApprovalNotificationListener._handleAIApprovalOutcome(payload, "Rejected"));
  }

  /** Users whose own role name matches `requiredRole` (case-insensitive), plus any role holding "admin"/"superadmin" — the exact same resolution AIOrchestrationService.decideApproval itself uses to authorize a decision, applied here to notify instead. */
  static async _resolveUsersByRole(tenantId, requiredRole) {
    const roles = await RoleModel.find({ tenantId, status: "active" }).select("name permissions").lean();
    const eligibleRoleNames = roles
      .filter((r) => r.name?.toLowerCase() === String(requiredRole).toLowerCase() || r.permissions?.includes("admin") || r.permissions?.includes("superadmin"))
      .map((r) => r.name);
    if (eligibleRoleNames.length === 0) return [];

    const users = await UserModel.find({ tenantId, role: { $in: eligibleRoleNames }, status: "active" }).select("_id").lean();
    return users.map((u) => u._id.toString());
  }

  static async _handleApprovalAssigned({ tenantId, approvalId, levelName, approverIds = [] }) {
    try {
      const request = await ApprovalRequestModel.findById(approvalId).select("module entityRef entityId").lean();
      const label = request ? `${request.module} ${request.entityRef || request.entityId}` : "a request";

      await Promise.all(approverIds.map((approverId) =>
        InAppNotificationService.createNotification({
          tenantId,
          userId: approverId,
          category: "Approval",
          title: `Approval required: ${levelName}`,
          body: `${label} needs your ${levelName} approval.`,
          actionUrl: `/approvals/${approvalId}`,
          groupKey: `approval:${approvalId}`,
          sourceEvent: "ApprovalAssigned"
        })
      ));
    } catch (err) {
      logger.error("ApprovalNotificationListener: ApprovalAssigned handling failed.", { approvalId, error: err.message });
    }
  }

  static async _handleApprovalOutcome({ tenantId, approvalId }, outcome) {
    try {
      const request = await ApprovalRequestModel.findById(approvalId).select("module entityRef entityId requestedBy").lean();
      if (!request?.requestedBy) return;

      await InAppNotificationService.createNotification({
        tenantId,
        userId: request.requestedBy,
        category: "Approval",
        title: `Request ${outcome.toLowerCase()}`,
        body: `Your ${request.module} request (${request.entityRef || request.entityId}) was ${outcome.toLowerCase()}.`,
        actionUrl: `/approvals/${approvalId}`,
        groupKey: `approval:${approvalId}`,
        sourceEvent: `Approval${outcome}`
      });
    } catch (err) {
      logger.error("ApprovalNotificationListener: approval outcome handling failed.", { approvalId, outcome, error: err.message });
    }
  }

  static async _handleAIApprovalRequested({ tenantId, approvalRequestId, toolName }) {
    try {
      const request = await AIApprovalRequestModel.findById(approvalRequestId).select("requiredRole requestedByName riskLevel").lean();
      if (!request) return;

      const userIds = await ApprovalNotificationListener._resolveUsersByRole(tenantId, request.requiredRole);
      await Promise.all(userIds.map((userId) =>
        InAppNotificationService.createNotification({
          tenantId,
          userId,
          category: "AIApproval",
          title: `AI proposal awaiting approval: ${toolName}`,
          body: `${request.requestedByName || "A user"} requested an AI-proposed "${toolName}" action (${request.riskLevel} risk) — your approval is required.`,
          actionUrl: `/ai/approvals/${approvalRequestId}`,
          groupKey: `ai-approval:${approvalRequestId}`,
          sourceEvent: "AIApprovalRequested"
        })
      ));
    } catch (err) {
      logger.error("ApprovalNotificationListener: AIApprovalRequested handling failed.", { approvalRequestId, error: err.message });
    }
  }

  static async _handleAIApprovalOutcome({ tenantId, approvalRequestId, toolName }, outcome) {
    try {
      const request = await AIApprovalRequestModel.findById(approvalRequestId).select("requestedBy").lean();
      if (!request?.requestedBy) return;

      await InAppNotificationService.createNotification({
        tenantId,
        userId: request.requestedBy,
        category: "AIApproval",
        title: `AI proposal ${outcome.toLowerCase()}`,
        body: `Your AI-proposed "${toolName}" action was ${outcome.toLowerCase()}.`,
        actionUrl: `/ai/approvals/${approvalRequestId}`,
        groupKey: `ai-approval:${approvalRequestId}`,
        sourceEvent: `AIApproval${outcome}`
      });
    } catch (err) {
      logger.error("ApprovalNotificationListener: AI approval outcome handling failed.", { approvalRequestId, outcome, error: err.message });
    }
  }
}

export default ApprovalNotificationListener;
