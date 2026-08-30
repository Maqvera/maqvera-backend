import PaymentRetryEngineService from "./PaymentRetryEngineService.js";
import { getPlatformConfig } from "../utils/platformConfig.js";
import SchedulerRunTracker from "../utils/schedulerRunTracker.js";
import logger from "../utils/logger.js";
import { withDistributedLock } from "../utils/distributedLock.js";
import { getSchedulerLockConfig } from "../utils/schedulerLockConfig.js";

const JOB_NAME = "PaymentRetryEngine";

/**
 * Enterprise Subscription Automation Layer — Automation #3 (Enterprise
 * Payment Retry Strategy). "Retry Queue -> Worker -> Payment Gateway" —
 * a real, frequent cron (`PLATFORM_PAYMENT_RETRY_POLL_CRON`, default every
 * 15 minutes) sweeping for due retries, wrapped in the same real
 * `SchedulerRunTracker` (run record, audit, versioned scan events,
 * threshold alerts) Automations #1/#2 already established. The generic
 * slow-run/zero-processed/spike alerts this tracker already provides are
 * exactly the spec's own "Retry Queue Growing... Excessive Failures ->
 * Manual Investigation" signals — real reuse, not a second bespoke
 * alerting subsystem.
 */
async function runRetrySweep() {
  const context = await SchedulerRunTracker.startRun(JOB_NAME, { eventPrefix: "PaymentRetryEngineScan" });
  try {
    const result = await PaymentRetryEngineService.processDueRetries();
    await SchedulerRunTracker.completeRun(context, result);
    if (result.processed > 0) logger.info(`Payment retry sweep completed (job ${context.run.jobId}).`, result);
  } catch (err) {
    await SchedulerRunTracker.failRun(context, err);
    logger.error("Payment retry sweep failed.", { error: err.message });
  }
}

let cronLib = null;
let retryJob = null;

class PaymentRetryEngineScheduler {
  static _initialized = false;

  static async init() {
    if (this._initialized) return;
    this._initialized = true;

    try {
      cronLib = (await import("node-cron")).default;
    } catch (err) {
      logger.warn("node-cron not available — payment retry sweeps disabled.", { error: err.message });
      return;
    }

    const config = getPlatformConfig();
    const expr = cronLib.validate(config.paymentRetryPollCron) ? config.paymentRetryPollCron : "*/15 * * * *";
    if (expr !== config.paymentRetryPollCron) logger.error(`Invalid PLATFORM_PAYMENT_RETRY_POLL_CRON: "${config.paymentRetryPollCron}". Falling back to "*/15 * * * *".`);

    retryJob = cronLib.schedule(expr, () => {
      // Real money — a failed payment must never be retried N times because
      // N instances all won this tick. SchedulerRunTracker (above) is
      // observability only, not mutual exclusion; this lock is the actual
      // "only one instance runs this" guarantee.
      withDistributedLock("scheduler:PaymentRetryEngineScheduler", getSchedulerLockConfig().defaultLockTtlMs, runRetrySweep)
        .catch((err) => logger.error("Cron payment retry sweep error", { error: err.message }));
    }, { scheduled: true, timezone: process.env.TZ || undefined });

    logger.info(`PaymentRetryEngineScheduler started — schedule: "${expr}".`);
  }

  static stop() {
    if (retryJob) { retryJob.stop(); retryJob = null; }
    this._initialized = false;
    logger.info("PaymentRetryEngineScheduler stopped.");
  }
}

export default PaymentRetryEngineScheduler;
