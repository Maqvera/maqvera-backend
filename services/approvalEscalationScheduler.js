import ApprovalRequestModel from "../models/ApprovalRequestModel.js";
import ApprovalWorkflowDefinitionModel from "../models/ApprovalWorkflowDefinitionModel.js";
import UserModel from "../models/Usermodel.js";
import RoleModel from "../models/Rolemodel.js";
import AuditLogModel from "../models/AuditLogmodel.js";
import { getDeliveryAdapter } from "./delivery/index.js";
import { resolveContactForMethod } from "./ReceiptService.js";
import { publishEvent } from "../utils/eventBus.js";
import { getFinanceConfig } from "../utils/financeConfig.js";
import logger from "../utils/logger.js";

// Enterprise Financial Approval Workflow — Finance Module Part 22. "SLA
// Tracking and Escalations... SLA Expiry, Reminder, Manager Escalation,
// Executive Escalation, Automatic Reassignment." Real, cron-driven —
// mirrors receivableOverdueScheduler.js's own cross-tenant, no-tenantId-
// filter query pattern (a request's own tenantId travels with it). Runs
// hourly (finer-grained than every other Part's own daily/monthly
// scheduler, since SLA deadlines are measured in hours).
async function runApprovalEscalation() {
  const startTime = Date.now();
  try {
    const now = new Date();
    const overdue = await ApprovalRequestModel.find({ status: "Pending", "levels.slaDeadline": { $lt: now } });

    let escalatedCount = 0;
    for (const request of overdue) {
      const currentLevel = request.levels[request.currentLevelIndex];
      if (!currentLevel || !currentLevel.slaDeadline || currentLevel.slaDeadline >= now) continue;

      const definition = await ApprovalWorkflowDefinitionModel.findOne({ _id: request.workflowDefinitionId, tenantId: request.tenantId }).lean();
      const escalation = definition?.escalation;
      request.status = "Escalated";
      request.escalatedAt = now;
      request.timeline.push({ event: "ApprovalEscalated", description: `SLA expired for level "${currentLevel.levelName}" (deadline ${currentLevel.slaDeadline.toISOString()}).`, performedBy: "system" });

      if (escalation?.enabled && escalation.escalateToPermissionKey) {
        const roles = await RoleModel.find({ tenantId: request.tenantId, status: "active", permissions: { $in: [escalation.escalateToPermissionKey, "admin"] } }).select("name").lean();
        const roleNames = roles.map((r) => r.name);
        const escalationTargets = roleNames.length > 0 ? await UserModel.find({ tenantId: request.tenantId, role: { $in: roleNames }, status: "active" }).select("_id").lean() : [];
        if (escalationTargets.length > 0) {
          request.escalatedTo = escalationTargets[0]._id;
          const config = getFinanceConfig();
          const adapter = getDeliveryAdapter(config.defaultApprovalNotificationChannel);
          for (const target of escalationTargets) {
            const user = await UserModel.findOne({ _id: target._id }).lean();
            const to = adapter && user ? resolveContactForMethod(config.defaultApprovalNotificationChannel, user) : null;
            if (adapter && to) await adapter.send({ to, subject: `Approval Escalated: ${request.module}`, body: `An overdue ${request.module} approval (level "${currentLevel.levelName}") has been escalated to you.`, receiptNumber: null, verificationUrl: null });
          }
        }
      }

      await request.save();
      escalatedCount += 1;

      await AuditLogModel.create({ action: "finance.approvalworkflow.escalate", module: "Finance", resource: "ApprovalRequest", resourceId: request._id.toString(), userId: null, tenantId: request.tenantId, details: { levelName: currentLevel.levelName } });
      publishEvent("ApprovalEscalated", { tenantId: request.tenantId, approvalId: request._id.toString(), module: request.module, levelName: currentLevel.levelName, escalatedTo: request.escalatedTo?.toString() || null });
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    logger.info(`Approval escalation check completed in ${elapsed}s — ${escalatedCount} request(s) escalated.`);
  } catch (err) {
    logger.error("Approval escalation check failed.", { error: err.message });
  }
}

let cronLib = null;
let escalationJob = null;

class ApprovalEscalationScheduler {
  static _initialized = false;

  static async init() {
    if (this._initialized) return;
    this._initialized = true;

    try {
      cronLib = (await import("node-cron")).default;
    } catch (err) {
      logger.warn("node-cron not available — approval escalation checks disabled.", { error: err.message });
      return;
    }

    const config = getFinanceConfig();
    const expr = cronLib.validate(config.approvalEscalationCron) ? config.approvalEscalationCron : "0 * * * *";
    if (expr !== config.approvalEscalationCron) logger.error(`Invalid APPROVAL_ESCALATION_CRON_SCHEDULE: "${config.approvalEscalationCron}". Falling back to "0 * * * *".`);

    escalationJob = cronLib.schedule(expr, () => {
      runApprovalEscalation().catch((err) => logger.error("Cron approval escalation error", { error: err.message }));
    }, { scheduled: true, timezone: process.env.TZ || undefined });

    logger.info(`ApprovalEscalationScheduler started — schedule: "${expr}".`);
  }

  static stop() {
    if (escalationJob) { escalationJob.stop(); escalationJob = null; }
    this._initialized = false;
    logger.info("ApprovalEscalationScheduler stopped.");
  }
}

export default ApprovalEscalationScheduler;
