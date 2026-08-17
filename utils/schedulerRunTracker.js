import crypto from "crypto";
import SchedulerRunModel from "../models/SchedulerRunModel.js";
import AuditLogModel from "../models/AuditLogmodel.js";
import { publishVersionedEvent } from "./eventVersioning.js";
import { getPlatformConfig } from "./platformConfig.js";
import logger from "./logger.js";

const EVENT_OWNER = "Enterprise Subscription Automation Layer";

/** Real SMTP send (reuses Financial Reporting's own EmailDeliveryAdapter — no separate integration) to one configured ops address; unset means logged only, never a fabricated delivery. */
const sendOpsAlert = async (subject, message) => {
  const config = getPlatformConfig();
  logger.warn(`[Scheduler Alert] ${subject}: ${message}`);
  if (!config.schedulerOpsAlertEmail) return;
  try {
    const { default: EmailDeliveryAdapter } = await import("../services/delivery/EmailDeliveryAdapter.js");
    const adapter = new EmailDeliveryAdapter();
    await adapter.send({ to: config.schedulerOpsAlertEmail, subject: `[Ops Alert] ${subject}`, body: `<p>${message}</p>` });
  } catch (error) {
    logger.error("Scheduler ops alert email failed.", { error: error.message });
  }
};

/**
 * Enterprise Subscription Automation Layer — Automation #1 (Enterprise
 * Subscription Scheduler). "Scheduler Metadata... every execution should
 * create a run record" + "Audit... every scheduler run MUST be audited" +
 * "Alerts... Fails, Runs Longer Than Threshold, Processes Zero Records,
 * Unexpected Spike -> Notification to Operations Team." One real, shared
 * implementation both `services/tenantSubscriptionScheduler.js` (the
 * daily sweep) and `services/subscriptionSuspensionEnforcementScheduler.js`
 * (the more frequent suspension job) wrap their real work in, so the
 * run-record/audit/alert/versioned-event behavior is identical and never
 * duplicated between the two jobs.
 */
class SchedulerRunTracker {
  /** `eventPrefix` lets a caller match the spec's own literal event names ("SubscriptionScan...") even when `jobName` (the human-readable run-record label, e.g. "SubscriptionScheduler") differs from it. */
  static async startRun(jobName, { eventPrefix = jobName, triggeredBy = "cron" } = {}) {
    const jobId = crypto.randomUUID();
    const startTime = Date.now();
    const run = await SchedulerRunModel.create({ jobId, jobName, status: "Running", triggeredBy, startedAt: new Date(startTime) });
    await publishVersionedEvent({ eventName: `${eventPrefix}Started`, version: 1, category: "Domain", owner: EVENT_OWNER, source: EVENT_OWNER, data: { jobId, jobName } });
    return { run, eventPrefix, startTime };
  }

  static async completeRun({ run, eventPrefix, startTime }, results = {}) {
    const durationMs = Date.now() - startTime;
    const processed = results.processed || 0;

    run.status = "Completed";
    run.finishedAt = new Date();
    run.durationMs = durationMs;
    run.processed = processed;
    run.renewed = results.renewed || 0;
    run.invoicesGenerated = results.invoicesGenerated || 0;
    run.remindersSent = results.remindersSent || 0;
    run.gracePeriodsStarted = results.gracePeriodsStarted || 0;
    run.suspended = results.suspended || 0;
    run.expired = results.expired || 0;
    run.archived = results.archived || 0;
    run.failed = results.failed || 0;
    await run.save();

    await AuditLogModel.create({ action: "platform.scheduler.run_completed", module: "Platform", resource: "SchedulerRun", resourceId: run.jobId, userId: null, tenantId: null, details: { jobName: run.jobName, ...results, durationMs } });
    await publishVersionedEvent({ eventName: `${eventPrefix}Completed`, version: 1, category: "Domain", owner: EVENT_OWNER, source: EVENT_OWNER, data: { jobId: run.jobId, jobName: run.jobName, durationMs, ...results } });

    await SchedulerRunTracker._evaluateAlerts(run, durationMs, processed);
    return run.toJSON();
  }

  static async failRun({ run, eventPrefix, startTime }, error) {
    const durationMs = Date.now() - startTime;

    run.status = "Failed";
    run.finishedAt = new Date();
    run.durationMs = durationMs;
    run.errorMessage = error?.message || String(error);
    await run.save();

    await AuditLogModel.create({ action: "platform.scheduler.run_failed", module: "Platform", resource: "SchedulerRun", resourceId: run.jobId, userId: null, tenantId: null, details: { jobName: run.jobName, error: run.errorMessage, durationMs } });
    await publishVersionedEvent({ eventName: `${eventPrefix}Failed`, version: 1, category: "Domain", owner: EVENT_OWNER, source: EVENT_OWNER, data: { jobId: run.jobId, jobName: run.jobName, error: run.errorMessage } });

    await sendOpsAlert(`${run.jobName} run failed`, `Job ${run.jobId} (${run.jobName}) failed after ${durationMs}ms: ${run.errorMessage}`);
    return run.toJSON();
  }

  static async _evaluateAlerts(run, durationMs, processed) {
    const config = getPlatformConfig();

    if (durationMs > config.schedulerRunSlowThresholdMs) {
      await sendOpsAlert(`${run.jobName} ran longer than threshold`, `Job ${run.jobId} took ${durationMs}ms, exceeding the configured ${config.schedulerRunSlowThresholdMs}ms threshold.`);
    }

    // "Processes Zero Records" / "Unexpected Spike" are both judged
    // against this job's own real recent history, never an absolute
    // guessed number — a genuinely quiet day (nothing due) is normal for
    // a young platform and shouldn't page anyone; a sudden drop-to-zero
    // AFTER a real pattern of activity, or a sudden multiple-x spike, are
    // the real anomalies worth a human's attention.
    const recentRuns = await SchedulerRunModel.find({ jobName: run.jobName, status: "Completed", _id: { $ne: run._id } }).sort({ startedAt: -1 }).limit(7).select("processed").lean();
    if (recentRuns.length >= 3) {
      const average = recentRuns.reduce((sum, r) => sum + (r.processed || 0), 0) / recentRuns.length;
      if (average > 0 && processed === 0) {
        await sendOpsAlert(`${run.jobName} processed zero records`, `Job ${run.jobId} processed 0 records this run, versus a recent average of ${average.toFixed(1)} over the last ${recentRuns.length} runs.`);
      } else if (average > 0 && processed > average * config.schedulerSpikeMultiplier) {
        await sendOpsAlert(`${run.jobName} processed an unexpected spike`, `Job ${run.jobId} processed ${processed} records vs a recent average of ${average.toFixed(1)} (over the last ${recentRuns.length} runs) — more than ${config.schedulerSpikeMultiplier}x.`);
      }
    }
  }
}

export default SchedulerRunTracker;
