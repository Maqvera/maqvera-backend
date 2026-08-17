import TenantSubscriptionService from "./TenantSubscriptionService.js";
import { getPlatformConfig } from "../utils/platformConfig.js";
import SchedulerRunTracker from "../utils/schedulerRunTracker.js";
import logger from "../utils/logger.js";

const JOB_NAME = "SubscriptionSuspensionEnforcement";

/**
 * Enterprise Subscription Automation Layer — Automation #1 (Enterprise
 * Subscription Scheduler), upgraded by Automation #8 (Enterprise Bulk
 * Processing Engine). "Suspension Enforcement Every 30 Minutes" — a real,
 * SEPARATE, more-frequent cron than the daily lifecycle sweep
 * (`services/tenantSubscriptionScheduler.js`). This is the real, most
 * likely place a genuine mass-simultaneous-expiry event ("1,000 companies
 * ki subscription ek hi date ko expire ho jaye") would actually surface —
 * so, unlike the daily sweep's own step 4 (still the plain sequential
 * `enforceGracePeriodSuspensions`), this job now runs the bulk-engine
 * variant: distributed-locked (a second instance racing this same 30-
 * minute tick skips rather than double-processing), batched, genuinely
 * concurrent per-tenant workers, checkpointed, and Dead-Letter-Queue-backed
 * for any tenant whose suspension keeps failing. Both variants still call
 * the exact same `suspendTenant` underneath — see
 * `TenantSubscriptionService.enforceGracePeriodSuspensionsBulk`'s own doc
 * comment for why this is a separate method rather than a rewrite.
 */
async function runSuspensionEnforcement() {
  const context = await SchedulerRunTracker.startRun(JOB_NAME, { eventPrefix: "SubscriptionSuspensionEnforcement" });
  try {
    const result = await TenantSubscriptionService.enforceGracePeriodSuspensionsBulk({ triggeredBy: "cron" });
    await SchedulerRunTracker.completeRun(context, result);
    if (result.suspended > 0) logger.info(`Subscription suspension enforcement completed (job ${context.run.jobId}).`, result);
  } catch (err) {
    await SchedulerRunTracker.failRun(context, err);
    logger.error("Subscription suspension enforcement failed.", { error: err.message });
  }
}

let cronLib = null;
let enforcementJob = null;

class SubscriptionSuspensionEnforcementScheduler {
  static _initialized = false;

  static async init() {
    if (this._initialized) return;
    this._initialized = true;

    try {
      cronLib = (await import("node-cron")).default;
    } catch (err) {
      logger.warn("node-cron not available — subscription suspension enforcement disabled.", { error: err.message });
      return;
    }

    const config = getPlatformConfig();
    const expr = cronLib.validate(config.subscriptionSuspensionEnforcementCron) ? config.subscriptionSuspensionEnforcementCron : "*/30 * * * *";
    if (expr !== config.subscriptionSuspensionEnforcementCron) logger.error(`Invalid PLATFORM_SUSPENSION_ENFORCEMENT_CRON: "${config.subscriptionSuspensionEnforcementCron}". Falling back to "*/30 * * * *".`);

    enforcementJob = cronLib.schedule(expr, () => {
      runSuspensionEnforcement().catch((err) => logger.error("Cron subscription suspension enforcement error", { error: err.message }));
    }, { scheduled: true, timezone: process.env.TZ || undefined });

    logger.info(`SubscriptionSuspensionEnforcementScheduler started — schedule: "${expr}".`);
  }

  static stop() {
    if (enforcementJob) { enforcementJob.stop(); enforcementJob = null; }
    this._initialized = false;
    logger.info("SubscriptionSuspensionEnforcementScheduler stopped.");
  }
}

export default SubscriptionSuspensionEnforcementScheduler;
