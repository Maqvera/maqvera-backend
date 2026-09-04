import TenantSubscriptionService from "./TenantSubscriptionService.js";
import { getPlatformConfig } from "../utils/platformConfig.js";
import SchedulerRunTracker from "../utils/schedulerRunTracker.js";
import logger from "../utils/logger.js";
import { withDistributedLock } from "../utils/distributedLock.js";
import { getSchedulerLockConfig } from "../utils/schedulerLockConfig.js";

const JOB_NAME = "SubscriptionScheduler";

// Enterprise Subscription Platform / Enterprise Subscription Automation
// Layer, Automation #1 (Enterprise Subscription Scheduler). "Scheduler...
// Daily... 00:05. Check Expired Subscription -> Find Unpaid -> Suspend
// Tenant... Publish Event. ONE TO ALL automatically." Unlike Finance's own
// currencyRevaluationScheduler.js (which is genuinely per-tenant work),
// TenantSubscriptionService.runDailyLifecycleSweep already operates across
// every tenant with a real subscription row in one pass (same
// direct-cross-tenant-query shape as receivableOverdueScheduler.js) — this
// job is a thin, real cron wrapper around it, now wrapped in
// SchedulerRunTracker for a real, persisted run record + audit + versioned
// scan-lifecycle events + threshold alerts ("Scheduler Metadata" /
// "Monitoring Dashboard" / "Alerts" from the automation spec).
async function runLifecycleSweep() {
  const context = await SchedulerRunTracker.startRun(JOB_NAME, { eventPrefix: "SubscriptionScan" });
  try {
    const results = await TenantSubscriptionService.runDailyLifecycleSweep();
    await SchedulerRunTracker.completeRun(context, results);
    logger.info(`Tenant subscription lifecycle sweep completed (job ${context.run.jobId}).`, results);
  } catch (err) {
    await SchedulerRunTracker.failRun(context, err);
    logger.error("Tenant subscription lifecycle sweep failed.", { error: err.message });
  }
}

let cronLib = null;
let lifecycleJob = null;

class TenantSubscriptionScheduler {
  static _initialized = false;

  static async init() {
    if (this._initialized) return;
    this._initialized = true;

    try {
      cronLib = (await import("node-cron")).default;
    } catch (err) {
      logger.warn("node-cron not available — tenant subscription lifecycle enforcement disabled.", { error: err.message });
      return;
    }

    const config = getPlatformConfig();
    const expr = cronLib.validate(config.subscriptionLifecycleCron) ? config.subscriptionLifecycleCron : "5 0 * * *";
    if (expr !== config.subscriptionLifecycleCron) logger.error(`Invalid PLATFORM_SUBSCRIPTION_LIFECYCLE_CRON: "${config.subscriptionLifecycleCron}". Falling back to "5 0 * * *".`);

    lifecycleJob = cronLib.schedule(expr, () => {
      withDistributedLock("scheduler:TenantSubscriptionScheduler", getSchedulerLockConfig().defaultLockTtlMs, runLifecycleSweep)
        .catch((err) => logger.error("Cron tenant subscription lifecycle sweep error", { error: err.message }));
    }, { scheduled: true, timezone: process.env.TZ || undefined });

    logger.info(`TenantSubscriptionScheduler started — schedule: "${expr}".`);
  }

  static stop() {
    if (lifecycleJob) { lifecycleJob.stop(); lifecycleJob = null; }
    this._initialized = false;
    logger.info("TenantSubscriptionScheduler stopped.");
  }
}

export default TenantSubscriptionScheduler;
