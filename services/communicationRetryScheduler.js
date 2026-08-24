import CommunicationPlatformService from "./CommunicationPlatformService.js";
import { getFinanceConfig } from "../utils/financeConfig.js";
import logger from "../utils/logger.js";

// Communication Platform (Part 11 fix, gap 2.6) — a real scheduled sweep
// for 'Failed' Email/SMS/WhatsApp/Push messages, mirroring
// webhookRetryScheduler.js's own cron pattern exactly. The actual business
// logic (deciding which messages are due, re-attempting them, respecting
// tenant suspension) lives in CommunicationPlatformService.processDueRetries;
// this is a thin cron wrapper calling into it, same division of
// responsibility as every other *Scheduler.js in this codebase.
async function runCommunicationRetrySweep() {
  const startTime = Date.now();
  try {
    const processed = await CommunicationPlatformService.processDueRetries();
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    if (processed > 0) logger.info(`Communication retry sweep completed in ${elapsed}s — ${processed} message(s) retried.`);
  } catch (err) {
    logger.error("Communication retry sweep failed.", { error: err.message });
  }
}

let cronLib = null;
let retryJob = null;

class CommunicationRetryScheduler {
  static _initialized = false;

  static async init() {
    if (this._initialized) return;
    this._initialized = true;

    try {
      cronLib = (await import("node-cron")).default;
    } catch (err) {
      logger.warn("node-cron not available — communication message retries disabled.", { error: err.message });
      return;
    }

    const config = getFinanceConfig();
    const expr = cronLib.validate(config.communicationRetryPollCron) ? config.communicationRetryPollCron : "*/5 * * * *";
    if (expr !== config.communicationRetryPollCron) logger.error(`Invalid COMMUNICATION_RETRY_POLL_CRON_SCHEDULE: "${config.communicationRetryPollCron}". Falling back to "*/5 * * * *".`);

    retryJob = cronLib.schedule(expr, () => {
      runCommunicationRetrySweep().catch((err) => logger.error("Cron communication retry sweep error", { error: err.message }));
    }, { scheduled: true, timezone: process.env.TZ || undefined });

    logger.info(`CommunicationRetryScheduler started — schedule: "${expr}".`);
  }

  static stop() {
    if (retryJob) { retryJob.stop(); retryJob = null; }
    this._initialized = false;
    logger.info("CommunicationRetryScheduler stopped.");
  }
}

export default CommunicationRetryScheduler;
