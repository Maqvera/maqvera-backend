import CustomerCollectionService from "./CustomerCollectionService.js";
import { getFinanceConfig } from "../utils/financeConfig.js";
import logger from "../utils/logger.js";

// Enterprise Customer Payments — Finance Module Part 18. Mirrors
// services/receivableOverdueScheduler.js's own real node-cron pattern
// exactly — a Customer Collection has its own paymentDueDate (which can
// diverge from the underlying invoices' own due dates once a collection
// request negotiates a different date), so it needs its own overdue pass
// rather than assuming AR's own overdue state implies this collection is
// overdue too.
async function runCollectionOverdueCheck() {
  const startTime = Date.now();
  try {
    const overdueCount = await CustomerCollectionService.markOverdueCollections();
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    logger.info(`Customer collection overdue check completed in ${elapsed}s — ${overdueCount} newly overdue.`);
  } catch (err) {
    logger.error("Customer collection overdue check failed.", { error: err.message });
  }
}

let cronLib = null;
let overdueJob = null;

class CustomerCollectionScheduler {
  static _initialized = false;

  static async init() {
    if (this._initialized) return;
    this._initialized = true;

    try {
      cronLib = (await import("node-cron")).default;
    } catch (err) {
      logger.warn("node-cron not available — customer collection overdue checks disabled.", { error: err.message });
      return;
    }

    const config = getFinanceConfig();
    const expr = cronLib.validate(config.customerCollectionOverdueCron) ? config.customerCollectionOverdueCron : "0 9 * * *";
    if (expr !== config.customerCollectionOverdueCron) logger.error(`Invalid CUSTOMER_COLLECTION_OVERDUE_CRON_SCHEDULE: "${config.customerCollectionOverdueCron}". Falling back to "0 9 * * *".`);

    overdueJob = cronLib.schedule(expr, () => {
      runCollectionOverdueCheck().catch((err) => logger.error("Cron customer collection overdue error", { error: err.message }));
    }, { scheduled: true, timezone: process.env.TZ || undefined });

    logger.info(`CustomerCollectionScheduler started — schedule: "${expr}".`);
  }

  static stop() {
    if (overdueJob) { overdueJob.stop(); overdueJob = null; }
    this._initialized = false;
    logger.info("CustomerCollectionScheduler stopped.");
  }
}

export default CustomerCollectionScheduler;
