import SubscriptionRenewalEngineService from "./SubscriptionRenewalEngineService.js";
import { getPlatformConfig } from "../utils/platformConfig.js";
import SchedulerRunTracker from "../utils/schedulerRunTracker.js";
import logger from "../utils/logger.js";

const JOB_NAME = "SubscriptionRenewalEngine";

/**
 * Enterprise Subscription Automation Layer — Automation #2 (Enterprise
 * Automatic Renewal Engine). "Ye woh engine hai jo Subscription Scheduler
 * ke baad execute hoga" — a real, separate cron (`PLATFORM_RENEWAL_ENGINE_CRON`,
 * default 00:15, ten minutes after Automation #1's own 00:05 daily sweep),
 * wrapped in the same real `SchedulerRunTracker` (run record, audit,
 * versioned scan events, threshold alerts) Automation #1 already
 * established — one shared implementation, not a second one.
 */
async function runRenewalSweep() {
  const context = await SchedulerRunTracker.startRun(JOB_NAME, { eventPrefix: "SubscriptionRenewalEngineScan" });
  try {
    const result = await SubscriptionRenewalEngineService.runAutomaticRenewalSweep();
    await SchedulerRunTracker.completeRun(context, result);
    logger.info(`Automatic renewal sweep completed (job ${context.run.jobId}).`, result);
  } catch (err) {
    await SchedulerRunTracker.failRun(context, err);
    logger.error("Automatic renewal sweep failed.", { error: err.message });
  }
}

let cronLib = null;
let renewalJob = null;

class SubscriptionRenewalEngineScheduler {
  static _initialized = false;

  static async init() {
    if (this._initialized) return;
    this._initialized = true;

    try {
      cronLib = (await import("node-cron")).default;
    } catch (err) {
      logger.warn("node-cron not available — automatic subscription renewal disabled.", { error: err.message });
      return;
    }

    const config = getPlatformConfig();
    const expr = cronLib.validate(config.renewalEngineCron) ? config.renewalEngineCron : "15 0 * * *";
    if (expr !== config.renewalEngineCron) logger.error(`Invalid PLATFORM_RENEWAL_ENGINE_CRON: "${config.renewalEngineCron}". Falling back to "15 0 * * *".`);

    renewalJob = cronLib.schedule(expr, () => {
      runRenewalSweep().catch((err) => logger.error("Cron automatic renewal sweep error", { error: err.message }));
    }, { scheduled: true, timezone: process.env.TZ || undefined });

    logger.info(`SubscriptionRenewalEngineScheduler started — schedule: "${expr}".`);
  }

  static stop() {
    if (renewalJob) { renewalJob.stop(); renewalJob = null; }
    this._initialized = false;
    logger.info("SubscriptionRenewalEngineScheduler stopped.");
  }
}

export default SubscriptionRenewalEngineScheduler;
