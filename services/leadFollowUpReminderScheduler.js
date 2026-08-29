import LeadModel from "../models/LeadModel.js";
import { getLeadConfig } from "../utils/leadConfig.js";
import { publishEvent } from "../utils/eventBus.js";
import logger from "../utils/logger.js";

let cronLib = null;
let reminderJob = null;

/**
 * Same "publish, never claim direct delivery" discipline as
 * services/appointmentReminderScheduler.js — NotificationDeliveryService
 * (already subscribed via server.js's NotificationDeliveryService.initEventListeners())
 * is the one real delivery path for the resulting NotificationRequested event.
 */
async function sendDueLeadFollowUpReminders() {
  const config = getLeadConfig();
  const now = new Date();

  const dueLeads = await LeadModel.find({
    followUpDate: { $lte: now },
    followUpReminderSentAt: null,
    status: { $nin: config.terminalLeadStatuses }
  });

  let sentCount = 0;
  for (const lead of dueLeads) {
    lead.followUpReminderSentAt = now;
    await lead.save();
    sentCount += 1;

    publishEvent("NotificationRequested", {
      tenantId: lead.tenantId,
      event: "LeadFollowUpDue",
      priority: "normal",
      channel: "InApp",
      recipientId: lead.assignedToUserId,
      leadId: lead._id,
      leadName: `${lead.firstName || ""} ${lead.lastName || ""}`.trim(),
      followUpDate: lead.followUpDate
    });

    publishEvent("LeadFollowUpReminderSent", { tenantId: lead.tenantId, leadId: lead._id.toString() });
  }

  return sentCount;
}

async function runLeadFollowUpSweep() {
  const startTime = Date.now();
  try {
    const sentCount = await sendDueLeadFollowUpReminders();
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    logger.info(`Lead follow-up sweep completed in ${elapsed}s — ${sentCount} reminder(s) sent.`);
  } catch (err) {
    logger.error("Lead follow-up reminder sweep failed.", { error: err.message });
  }
}

class LeadFollowUpReminderScheduler {
  static _initialized = false;

  static async init() {
    if (this._initialized) return;
    this._initialized = true;

    try {
      cronLib = (await import("node-cron")).default;
    } catch (err) {
      logger.warn("node-cron not available — lead follow-up reminder checks disabled.", { error: err.message });
      return;
    }

    const config = getLeadConfig();
    const expr = cronLib.validate(config.leadFollowUpReminderCronSchedule) ? config.leadFollowUpReminderCronSchedule : "*/30 * * * *";
    if (expr !== config.leadFollowUpReminderCronSchedule) logger.error(`Invalid LEAD_FOLLOWUP_REMINDER_CRON_SCHEDULE: "${config.leadFollowUpReminderCronSchedule}". Falling back to "*/30 * * * *".`);

    reminderJob = cronLib.schedule(expr, () => {
      runLeadFollowUpSweep().catch((err) => logger.error("Cron lead follow-up sweep error", { error: err.message }));
    }, { scheduled: true, timezone: process.env.TZ || undefined });

    logger.info(`LeadFollowUpReminderScheduler started — schedule: "${expr}".`);
  }

  static stop() {
    if (reminderJob) { reminderJob.stop(); reminderJob = null; }
    this._initialized = false;
    logger.info("LeadFollowUpReminderScheduler stopped.");
  }
}

export default LeadFollowUpReminderScheduler;
