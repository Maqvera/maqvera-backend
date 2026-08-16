import SubscriptionService from "./SubscriptionService.js";
import { getFinanceConfig } from "../utils/financeConfig.js";
import logger from "../utils/logger.js";

// Enterprise Customer Payments — Finance Module Part 18 Part 4. Mirrors
// services/customerCollectionScheduler.js's own real node-cron pattern
// exactly. One daily pass covers both due renewals (`nextBillingDate` has
// arrived) and grace-period retries (already `PastDue`) — both funnel
// through the same real `SubscriptionService.runBillingCycle`.
async function runSubscriptionBilling() {
  const startTime = Date.now();
  try {
    const dueCount = await SubscriptionService.runDueBillingCycles();
    const retryCount = await SubscriptionService.runGracePeriodRetries();
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    logger.info(`Subscription billing run completed in ${elapsed}s — ${dueCount} due cycle(s), ${retryCount} grace-period retry(ies).`);
  } catch (err) {
    logger.error("Subscription billing run failed.", { error: err.message });
  }
}

let cronLib = null;
let billingJob = null;

class SubscriptionBillingScheduler {
  static _initialized = false;

  static async init() {
    if (this._initialized) return;
    this._initialized = true;

    try {
      cronLib = (await import("node-cron")).default;
    } catch (err) {
      logger.warn("node-cron not available — subscription billing runs disabled.", { error: err.message });
      return;
    }

    const config = getFinanceConfig();
    const expr = cronLib.validate(config.subscriptionBillingCron) ? config.subscriptionBillingCron : "0 6 * * *";
    if (expr !== config.subscriptionBillingCron) logger.error(`Invalid SUBSCRIPTION_BILLING_CRON_SCHEDULE: "${config.subscriptionBillingCron}". Falling back to "0 6 * * *".`);

    billingJob = cronLib.schedule(expr, () => {
      runSubscriptionBilling().catch((err) => logger.error("Cron subscription billing error", { error: err.message }));
    }, { scheduled: true, timezone: process.env.TZ || undefined });

    logger.info(`SubscriptionBillingScheduler started — schedule: "${expr}".`);
  }

  static stop() {
    if (billingJob) { billingJob.stop(); billingJob = null; }
    this._initialized = false;
    logger.info("SubscriptionBillingScheduler stopped.");
  }
}

export default SubscriptionBillingScheduler;
