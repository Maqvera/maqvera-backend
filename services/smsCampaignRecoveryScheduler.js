import mongoose from "mongoose";
import SmsPlatformService from "./SmsPlatformService.js";
import logger from "../utils/logger.js";
import { withDistributedLock } from "../utils/distributedLock.js";
import { getSchedulerLockConfig } from "../utils/schedulerLockConfig.js";

const SMS_CAMPAIGN_RECOVERY_CRON = process.env.SMS_CAMPAIGN_RECOVERY_CRON_SCHEDULE || "*/5 * * * *";
const STALE_AFTER_MS = parseInt(process.env.SMS_CAMPAIGN_STALE_AFTER_MS || String(10 * 60 * 1000), 10);

// Part 10 fix — mirrors aiWorkflowRecoveryScheduler.js's exact pattern:
// periodically sweeps for bulk SMS campaigns abandoned mid-flight by a
// crashed/restarted process (status "Processing" with no checkpoint
// heartbeat since SmsPlatformService's own per-batch checkpointing was
// added) and resumes them via SmsPlatformService.recoverStuckCampaigns().
async function runRecoverySweep() {
  if (mongoose.connection?.readyState !== 1) return;
  const startTime = Date.now();
  try {
    const result = await SmsPlatformService.recoverStuckCampaigns({ staleAfterMs: STALE_AFTER_MS });
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    if (result.scanned > 0) {
      logger.info(`SMS campaign recovery sweep completed in ${elapsed}s — ${result.scanned} stuck campaign(s) found, ${result.recovered} resumed.`);
    }
  } catch (err) {
    logger.error("SMS campaign recovery sweep failed.", { error: err.message });
  }
}

let cronLib = null;
let recoveryJob = null;

class SmsCampaignRecoveryScheduler {
  static _initialized = false;

  static async init() {
    if (this._initialized) return;
    this._initialized = true;

    try {
      cronLib = (await import("node-cron")).default;
    } catch (err) {
      logger.warn("node-cron not available — SMS campaign recovery sweeps disabled.", { error: err.message });
      return;
    }

    const expr = cronLib.validate(SMS_CAMPAIGN_RECOVERY_CRON) ? SMS_CAMPAIGN_RECOVERY_CRON : "*/5 * * * *";
    if (expr !== SMS_CAMPAIGN_RECOVERY_CRON) logger.error(`Invalid SMS_CAMPAIGN_RECOVERY_CRON_SCHEDULE: "${SMS_CAMPAIGN_RECOVERY_CRON}". Falling back to "*/5 * * * *".`);

    recoveryJob = cronLib.schedule(expr, () => {
      withDistributedLock("scheduler:SmsCampaignRecoveryScheduler", getSchedulerLockConfig().defaultLockTtlMs, runRecoverySweep)
        .catch((err) => logger.error("Cron SMS campaign recovery sweep error", { error: err.message }));
    }, { scheduled: true, timezone: process.env.TZ || undefined });

    logger.info(`SmsCampaignRecoveryScheduler started — schedule: "${expr}".`);
  }

  static stop() {
    if (recoveryJob) { recoveryJob.stop(); recoveryJob = null; }
    this._initialized = false;
    logger.info("SmsCampaignRecoveryScheduler stopped.");
  }
}

export default SmsCampaignRecoveryScheduler;
