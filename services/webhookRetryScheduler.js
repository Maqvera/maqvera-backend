import WebhookService from "./WebhookService.js";
import { getFinanceConfig } from "../utils/financeConfig.js";
import logger from "../utils/logger.js";

// Enterprise Webhook Standard (Enterprise Architecture Hardening Phase,
// Improvement 14). "Retry Policy... 1 Minute -> 5 Minutes -> ... -> 24
// Hours -> Dead Letter Queue." A real scheduled sweep — mirrors
// auditRetentionScheduler.js's own cron pattern exactly. The actual
// business logic (deciding which deliveries are due, re-attempting them,
// escalating to the Dead Letter Queue) lives in WebhookService itself
// (`processDueRetries`); this is a thin cron wrapper calling into it, same
// division of responsibility as every other *Scheduler.js in this codebase.
async function runWebhookRetrySweep() {
  const startTime = Date.now();
  try {
    const processed = await WebhookService.processDueRetries();
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    if (processed > 0) logger.info(`Webhook retry sweep completed in ${elapsed}s — ${processed} due deliverie(s) processed.`);
  } catch (err) {
    logger.error("Webhook retry sweep failed.", { error: err.message });
  }
}

let cronLib = null;
let retryJob = null;

class WebhookRetryScheduler {
  static _initialized = false;

  static async init() {
    if (this._initialized) return;
    this._initialized = true;

    try {
      cronLib = (await import("node-cron")).default;
    } catch (err) {
      logger.warn("node-cron not available — webhook long-horizon retries disabled.", { error: err.message });
      return;
    }

    const config = getFinanceConfig();
    const expr = cronLib.validate(config.webhookRetryPollCron) ? config.webhookRetryPollCron : "* * * * *";
    if (expr !== config.webhookRetryPollCron) logger.error(`Invalid WEBHOOK_RETRY_POLL_CRON_SCHEDULE: "${config.webhookRetryPollCron}". Falling back to "* * * * *".`);

    retryJob = cronLib.schedule(expr, () => {
      runWebhookRetrySweep().catch((err) => logger.error("Cron webhook retry sweep error", { error: err.message }));
    }, { scheduled: true, timezone: process.env.TZ || undefined });

    logger.info(`WebhookRetryScheduler started — schedule: "${expr}".`);
  }

  static stop() {
    if (retryJob) { retryJob.stop(); retryJob = null; }
    this._initialized = false;
    logger.info("WebhookRetryScheduler stopped.");
  }
}

export default WebhookRetryScheduler;
