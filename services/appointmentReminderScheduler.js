import VisaAppointmentModel from "../models/VisaAppointmentModel.js";
import VisaCaseModel from "../models/VisaCaseModel.js";
import { publishEvent } from "../utils/eventBus.js";
import logger from "../utils/logger.js";

// ─────────────────────────────────────────────────────────────
// Configuration — all from environment
// ─────────────────────────────────────────────────────────────
const REMINDER_CHECK_CRON = process.env.APPOINTMENT_REMINDER_CRON_SCHEDULE || "*/15 * * * *";

let cronLib = null;
let reminderJob = null;

/**
 * Sends any reminders whose scheduled time has arrived. "Reminder System ...
 * Configurable" was previously only a schedule *computation* at booking
 * time — reminders[].status stayed "pending" forever, nothing ever sent
 * one. No real email/SMS/WhatsApp/Push/Voice provider exists anywhere in
 * this codebase, so this publishes NotificationRequested (the same honest
 * pattern used everywhere else) rather than claiming delivery.
 */
async function sendDueReminders() {
  const now = new Date();
  const appointments = await VisaAppointmentModel.find({
    "reminders.status": "pending",
    "reminders.scheduledFor": { $lte: now },
    status: { $nin: ["Cancelled", "Rejected", "Completed", "No Show", "Missed"] },
    isSoftDeleted: { $ne: true }
  });

  let sentCount = 0;
  for (const appt of appointments) {
    let anySent = false;
    for (const reminder of appt.reminders) {
      if (reminder.status === "pending" && reminder.scheduledFor <= now) {
        reminder.status = "sent";
        reminder.sentAt = now;
        anySent = true;
        sentCount += 1;

        publishEvent("NotificationRequested", {
          tenantId: appt.tenantId,
          event: "AppointmentReminder",
          priority: "normal",
          channel: reminder.channel,
          recipientId: appt.travelerId ? appt.travelerId.toString() : null,
          appointmentId: appt._id,
          visaCaseId: appt.visaCaseId,
          appointmentType: appt.appointmentType,
          appointmentDate: appt.appointmentDate,
          appointmentTime: appt.appointmentTime
        });

        publishEvent("AppointmentReminderSent", {
          appointmentId: appt._id,
          visaCaseId: appt.visaCaseId,
          tenantId: appt.tenantId,
          channel: reminder.channel
        });
      }
    }

    if (anySent && appt.status === "Scheduled") {
      appt.status = "Reminder Sent";
    }

    if (anySent) {
      await appt.save();
    }
  }

  return sentCount;
}

/**
 * "Missed" is a real Appointment Lifecycle status and AppointmentMissed a
 * real Domain Event, but nothing ever reached either — recordAttendance
 * only ever sets Checked In / No Show / Cancelled from an explicit staff
 * action. This sweeps appointments whose scheduled time has passed with no
 * attendance ever recorded at all.
 */
async function markMissedAppointments() {
  const now = new Date();
  const candidates = await VisaAppointmentModel.find({
    status: { $in: ["Scheduled", "Reminder Sent", "Confirmed"] },
    "attendance.status": "pending",
    isSoftDeleted: { $ne: true }
  });

  let missedCount = 0;
  for (const appt of candidates) {
    const appointmentMoment = new Date(`${appt.appointmentDate.toISOString().slice(0, 10)}T${appt.appointmentTime}:00`);
    if (appointmentMoment >= now) continue;

    appt.status = "Missed";
    await appt.save();
    missedCount += 1;

    const visaCase = await VisaCaseModel.findOne({ _id: appt.visaCaseId, tenantId: appt.tenantId });
    if (visaCase) {
      visaCase.timeline.push({
        event: "AppointmentMissed",
        description: `${appt.appointmentType} appointment (${appt.appointmentNumber}) was missed — no attendance recorded.`,
        performedBy: "system",
        timestamp: now
      });
      await visaCase.save();
    }

    publishEvent("AppointmentMissed", { appointmentId: appt._id, visaCaseId: appt.visaCaseId, tenantId: appt.tenantId });
  }

  return missedCount;
}

async function runAppointmentSweep() {
  const startTime = Date.now();
  try {
    const [reminderCount, missedCount] = await Promise.all([sendDueReminders(), markMissedAppointments()]);
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    logger.info(`Appointment sweep completed in ${elapsed}s — ${reminderCount} reminder(s) sent, ${missedCount} marked missed.`);
  } catch (err) {
    logger.error("Appointment reminder/missed sweep failed.", { error: err.message });
  }
}

class AppointmentReminderScheduler {
  static _initialized = false;

  static async init() {
    if (this._initialized) return;
    this._initialized = true;

    try {
      cronLib = (await import("node-cron")).default;
    } catch (err) {
      logger.warn("node-cron not available — appointment reminder checks disabled.", { error: err.message });
      return;
    }

    const expr = cronLib.validate(REMINDER_CHECK_CRON) ? REMINDER_CHECK_CRON : "*/15 * * * *";
    if (expr !== REMINDER_CHECK_CRON) logger.error(`Invalid APPOINTMENT_REMINDER_CRON_SCHEDULE: "${REMINDER_CHECK_CRON}". Falling back to "*/15 * * * *".`);

    reminderJob = cronLib.schedule(expr, () => {
      runAppointmentSweep().catch((err) => logger.error("Cron appointment sweep error", { error: err.message }));
    }, { scheduled: true, timezone: process.env.TZ || undefined });

    logger.info(`AppointmentReminderScheduler started — schedule: "${expr}".`);
  }

  static stop() {
    if (reminderJob) { reminderJob.stop(); reminderJob = null; }
    this._initialized = false;
    logger.info("AppointmentReminderScheduler stopped.");
  }
}

export default AppointmentReminderScheduler;
