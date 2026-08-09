import mongoose from "mongoose";
import AIApprovalRequestModel from "../models/AIApprovalRequestModel.js";
import { getAIApprovalTimeoutConfig } from "../utils/aiConfig.js";
import { publishEvent } from "../utils/eventBus.js";
import logger from "../utils/logger.js";

/**
 * EXT-029 §15 "Timeout Handling — Approval Timeout -> Reminder ->
 * Escalation -> Auto Cancel (Configurable)." Product decision made for
 * this build (confirmed explicitly, not guessed): reminder and escalation
 * notifications fire on schedule, but a pending approval is NEVER
 * auto-rejected — every real booking/cancellation proposal only ever
 * resolves through an actual human decision via
 * AIOrchestrationService.decideApproval(). `reminderSentAt`/`escalatedAt`
 * ensure each notification fires at most once per request, not every sweep.
 */
async function sweepPendingApprovals() {
  const { reminderAfterMs, escalationAfterMs } = getAIApprovalTimeoutConfig();
  const now = Date.now();

  const reminderDue = await AIApprovalRequestModel.find({
    status: "pending",
    reminderSentAt: null,
    createdAt: { $lte: new Date(now - reminderAfterMs) }
  });
  let reminderCount = 0;
  for (const request of reminderDue) {
    request.reminderSentAt = new Date();
    await request.save();
    reminderCount += 1;
    publishEvent("NotificationRequested", {
      tenantId: request.tenantId, event: "AIApprovalReminder", priority: "normal",
      approvalRequestId: request._id, toolName: request.toolName, requestedBy: request.requestedBy, requiredRole: request.requiredRole
    });
  }

  const escalationDue = await AIApprovalRequestModel.find({
    status: "pending",
    escalatedAt: null,
    createdAt: { $lte: new Date(now - escalationAfterMs) }
  });
  let escalationCount = 0;
  for (const request of escalationDue) {
    request.escalatedAt = new Date();
    await request.save();
    escalationCount += 1;
    publishEvent("NotificationRequested", {
      tenantId: request.tenantId, event: "AIApprovalEscalated", priority: "high",
      approvalRequestId: request._id, toolName: request.toolName, requestedBy: request.requestedBy, requiredRole: request.requiredRole
    });
    publishEvent("AIApprovalEscalated", { approvalRequestId: request._id, tenantId: request.tenantId, toolName: request.toolName });
  }

  return { reminderCount, escalationCount };
}

async function runApprovalTimeoutSweep() {
  if (mongoose.connection?.readyState !== 1) return;
  const startTime = Date.now();
  try {
    const { reminderCount, escalationCount } = await sweepPendingApprovals();
    if (reminderCount > 0 || escalationCount > 0) {
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      logger.info(`AI approval timeout sweep completed in ${elapsed}s — ${reminderCount} reminder(s), ${escalationCount} escalation(s) sent. No approval was auto-rejected (not enabled for this build).`);
    }
  } catch (err) {
    logger.error("AI approval timeout sweep failed.", { error: err.message });
  }
}

let cronLib = null;
let sweepJob = null;

class AIApprovalTimeoutScheduler {
  static _initialized = false;

  static async init() {
    if (this._initialized) return;
    this._initialized = true;

    try {
      cronLib = (await import("node-cron")).default;
    } catch (err) {
      logger.warn("node-cron not available — AI approval timeout sweeps disabled.", { error: err.message });
      return;
    }

    const { sweepCronSchedule } = getAIApprovalTimeoutConfig();
    const expr = cronLib.validate(sweepCronSchedule) ? sweepCronSchedule : "*/15 * * * *";
    if (expr !== sweepCronSchedule) logger.error(`Invalid AI_APPROVAL_TIMEOUT_CRON_SCHEDULE: "${sweepCronSchedule}". Falling back to "*/15 * * * *".`);

    sweepJob = cronLib.schedule(expr, () => {
      runApprovalTimeoutSweep().catch((err) => logger.error("Cron AI approval timeout sweep error", { error: err.message }));
    }, { scheduled: true, timezone: process.env.TZ || undefined });

    logger.info(`AIApprovalTimeoutScheduler started — schedule: "${expr}".`);
  }

  static stop() {
    if (sweepJob) { sweepJob.stop(); sweepJob = null; }
    this._initialized = false;
    logger.info("AIApprovalTimeoutScheduler stopped.");
  }
}

export default AIApprovalTimeoutScheduler;
