import CurrencyModel from "../models/CurrencyModel.js";
import CurrencyService from "./CurrencyService.js";
import { getFinanceConfig } from "../utils/financeConfig.js";
import logger from "../utils/logger.js";

// Enterprise Multi-Currency & Foreign Exchange — Finance Module Part 19.
// "Automatic period-end revaluation." Unlike receivableOverdueScheduler.js
// (which queries AccountsReceivableModel directly across every tenant in
// one pass — a receivable's own tenantId travels with it), revaluation is
// tenant-scoped per call (CurrencyService.runPeriodEndRevaluation(tenantId, ...)),
// so this job first finds which tenants actually have real foreign-currency
// exposure configured (an Active, non-base Currency row) and only runs for
// those — a tenant that never created a second currency incurs zero extra
// work every period.
async function runRevaluation() {
  const startTime = Date.now();
  try {
    const tenantIds = await CurrencyModel.distinct("tenantId", { status: "Active", isBaseCurrency: false });
    let totalRevalued = 0;
    for (const tenantId of tenantIds) {
      try {
        const result = await CurrencyService.runPeriodEndRevaluation(tenantId, "system");
        totalRevalued += result.revalued;
      } catch (err) {
        logger.error(`Currency revaluation failed for tenant ${tenantId}.`, { error: err.message });
      }
    }
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    logger.info(`Currency revaluation completed in ${elapsed}s — ${tenantIds.length} tenant(s), ${totalRevalued} record(s) revalued.`);
  } catch (err) {
    logger.error("Currency revaluation run failed.", { error: err.message });
  }
}

let cronLib = null;
let revaluationJob = null;

class CurrencyRevaluationScheduler {
  static _initialized = false;

  static async init() {
    if (this._initialized) return;
    this._initialized = true;

    try {
      cronLib = (await import("node-cron")).default;
    } catch (err) {
      logger.warn("node-cron not available — currency revaluation disabled.", { error: err.message });
      return;
    }

    const config = getFinanceConfig();
    const expr = cronLib.validate(config.fxRevaluationCron) ? config.fxRevaluationCron : "0 1 1 * *";
    if (expr !== config.fxRevaluationCron) logger.error(`Invalid FX_REVALUATION_CRON_SCHEDULE: "${config.fxRevaluationCron}". Falling back to "0 1 1 * *".`);

    revaluationJob = cronLib.schedule(expr, () => {
      runRevaluation().catch((err) => logger.error("Cron currency revaluation error", { error: err.message }));
    }, { scheduled: true, timezone: process.env.TZ || undefined });

    logger.info(`CurrencyRevaluationScheduler started — schedule: "${expr}".`);
  }

  static stop() {
    if (revaluationJob) { revaluationJob.stop(); revaluationJob = null; }
    this._initialized = false;
    logger.info("CurrencyRevaluationScheduler stopped.");
  }
}

export default CurrencyRevaluationScheduler;
