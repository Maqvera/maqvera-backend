import EnterpriseDocumentModel from "../models/EnterpriseDocumentModel.js";
import VisaCaseModel from "../models/VisaCaseModel.js";
import { publishEvent } from "../utils/eventBus.js";
import logger from "../utils/logger.js";
import { withDistributedLock } from "../utils/distributedLock.js";
import { getSchedulerLockConfig } from "../utils/schedulerLockConfig.js";

// ─────────────────────────────────────────────────────────────
// Configuration — all from environment
// ─────────────────────────────────────────────────────────────
const EXPIRY_CHECK_CRON = process.env.DOCUMENT_EXPIRY_CRON_SCHEDULE || "0 3 * * *";
const REMINDER_WINDOW_DAYS = Number.parseInt(process.env.DOCUMENT_EXPIRY_REMINDER_DAYS || "30", 10) || 30;

let cronLib = null;
let expiryJob = null;

/**
 * Marks newly-expired documents and publishes DocumentExpired for each.
 * "Document Expiry ... Passport/CNIC/Insurance/Medical/Police Clearance/
 * Vaccination Expiry" — was tracked as a plain field nothing ever checked.
 */
async function checkExpiredDocuments() {
  const now = new Date();
  const expired = await EnterpriseDocumentModel.find({
    expiryDate: { $lte: now },
    isExpired: false,
    isSoftDeleted: { $ne: true }
  });

  for (const doc of expired) {
    doc.isExpired = true;
    doc.expiredAt = now;
    await doc.save();

    publishEvent("DocumentExpired", {
      documentId: doc._id,
      tenantId: doc.tenantId,
      referenceId: doc.referenceId,
      documentType: doc.documentType,
      expiryDate: doc.expiryDate
    });

    if (doc.module === "Visa" && doc.referenceId) {
      const visaCase = await VisaCaseModel.findOne({ _id: doc.referenceId, tenantId: doc.tenantId });
      if (visaCase) {
        const reqIndex = visaCase.requiredDocuments.findIndex((r) => r.documentType.toLowerCase() === doc.documentType.toLowerCase());
        if (reqIndex !== -1) visaCase.requiredDocuments[reqIndex].status = "expired";
        visaCase.timeline.push({
          event: "DocumentExpired",
          description: `${doc.documentType} expired on ${doc.expiryDate.toISOString().split("T")[0]}.`,
          performedBy: "system",
          timestamp: now
        });
        await visaCase.save();
      }
    }
  }

  return expired.length;
}

/**
 * "Automatic reminders supported" — publishes a NotificationRequested (not
 * a claim that an email/SMS was actually sent, since no notification
 * provider is wired up anywhere in this codebase) for documents entering
 * the reminder window, once per document.
 */
async function sendExpiryReminders() {
  const now = new Date();
  const windowEnd = new Date(now.getTime() + REMINDER_WINDOW_DAYS * 24 * 60 * 60 * 1000);

  const dueForReminder = await EnterpriseDocumentModel.find({
    expiryDate: { $gt: now, $lte: windowEnd },
    isExpired: false,
    isSoftDeleted: { $ne: true },
    expiryReminderSentAt: null
  });

  for (const doc of dueForReminder) {
    doc.expiryReminderSentAt = now;
    await doc.save();

    publishEvent("NotificationRequested", {
      tenantId: doc.tenantId,
      event: "DocumentExpiringSoon",
      priority: "normal",
      referenceId: doc.referenceId,
      documentId: doc._id,
      documentType: doc.documentType,
      expiryDate: doc.expiryDate
    });
  }

  return dueForReminder.length;
}

async function runExpiryCheck() {
  const startTime = Date.now();
  try {
    const [expiredCount, reminderCount] = await Promise.all([checkExpiredDocuments(), sendExpiryReminders()]);
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    logger.info(`Document expiry check completed in ${elapsed}s — ${expiredCount} newly expired, ${reminderCount} reminders queued.`);
  } catch (err) {
    logger.error("Document expiry check failed.", { error: err.message });
  }
}

class DocumentExpiryScheduler {
  static _initialized = false;

  static async init() {
    if (this._initialized) return;
    this._initialized = true;

    try {
      cronLib = (await import("node-cron")).default;
    } catch (err) {
      logger.warn("node-cron not available — document expiry checks disabled.", { error: err.message });
      return;
    }

    const expr = cronLib.validate(EXPIRY_CHECK_CRON) ? EXPIRY_CHECK_CRON : "0 3 * * *";
    if (expr !== EXPIRY_CHECK_CRON) logger.error(`Invalid DOCUMENT_EXPIRY_CRON_SCHEDULE: "${EXPIRY_CHECK_CRON}". Falling back to "0 3 * * *".`);

    expiryJob = cronLib.schedule(expr, () => {
      withDistributedLock("scheduler:DocumentExpiryScheduler", getSchedulerLockConfig().defaultLockTtlMs, runExpiryCheck)
        .catch((err) => logger.error("Cron document expiry error", { error: err.message }));
    }, { scheduled: true, timezone: process.env.TZ || undefined });

    logger.info(`DocumentExpiryScheduler started — schedule: "${expr}", reminder window: ${REMINDER_WINDOW_DAYS} days.`);
  }

  static stop() {
    if (expiryJob) { expiryJob.stop(); expiryJob = null; }
    this._initialized = false;
    logger.info("DocumentExpiryScheduler stopped.");
  }
}

export default DocumentExpiryScheduler;
