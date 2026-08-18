import FinancialPeriodModel from "../models/FinancialPeriodModel.js";
import { getCurrentMuharramPeriod, hasCrossedMuharramPeriod } from "../utils/hijriCalendar.js";
import logger from "../utils/logger.js";

const ROLLOVER_CRON = process.env.MUHARRAM_PERIOD_ROLLOVER_CRON_SCHEDULE || "0 2 * * *";

/**
 * Muharram-to-Muharram annual accounting period rollover (booking-module
 * PRD Part A item #5). Opt-in per tenant: only tenants that already have at
 * least one periodType:"muharram_annual" FinancialPeriodModel record get
 * rolled forward — this job never auto-enrolls a tenant into the cycle,
 * same "unconfigured = no behavior" stance FinancialPeriodService.
 * assertPeriodOpen already takes for financial periods generally.
 *
 * Never mutates an existing period (no "currentPeriod" flag flipped on old
 * records, no in-place date rewrite) — "the current period" is always
 * resolved by querying for whichever period's [startDate, endDate) covers
 * today, exactly like FinancialPeriodService.findPeriodForDate already
 * does. Crossing into a new cycle only ever creates a new document.
 */
async function rolloverMuharramPeriods() {
  const currentCycle = getCurrentMuharramPeriod(new Date());
  const tenantIds = await FinancialPeriodModel.distinct("tenantId", { periodType: "muharram_annual" });

  let createdCount = 0;
  for (const tenantId of tenantIds) {
    const latest = await FinancialPeriodModel.findOne({ tenantId, periodType: "muharram_annual" })
      .sort({ startDate: -1 })
      .lean();

    if (latest && !hasCrossedMuharramPeriod(latest, new Date())) continue; // still inside its current cycle

    const alreadyCreated = await FinancialPeriodModel.findOne({
      tenantId, periodType: "muharram_annual", financialYear: currentCycle.financialYear
    }).lean();
    if (alreadyCreated) continue;

    await FinancialPeriodModel.create({
      tenantId,
      periodType: "muharram_annual",
      financialYear: currentCycle.financialYear,
      startDate: currentCycle.periodStart,
      endDate: currentCycle.periodEnd,
      status: "Open"
    });
    createdCount += 1;
  }

  return createdCount;
}

async function runRolloverCheck() {
  const startTime = Date.now();
  try {
    const createdCount = await rolloverMuharramPeriods();
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    logger.info(`Muharram period rollover check completed in ${elapsed}s — ${createdCount} new period(s) created.`);
  } catch (err) {
    logger.error("Muharram period rollover check failed.", { error: err.message });
  }
}

let cronLib = null;
let rolloverJob = null;

class MuharramPeriodScheduler {
  static _initialized = false;

  static async init() {
    if (this._initialized) return;
    this._initialized = true;

    try {
      cronLib = (await import("node-cron")).default;
    } catch (err) {
      logger.warn("node-cron not available — Muharram period rollover disabled.", { error: err.message });
      return;
    }

    const expr = cronLib.validate(ROLLOVER_CRON) ? ROLLOVER_CRON : "0 2 * * *";
    if (expr !== ROLLOVER_CRON) logger.error(`Invalid MUHARRAM_PERIOD_ROLLOVER_CRON_SCHEDULE: "${ROLLOVER_CRON}". Falling back to "0 2 * * *".`);

    rolloverJob = cronLib.schedule(expr, () => {
      runRolloverCheck().catch((err) => logger.error("Cron Muharram period rollover error", { error: err.message }));
    }, { scheduled: true, timezone: process.env.TZ || undefined });

    logger.info(`MuharramPeriodScheduler started — schedule: "${expr}".`);
  }

  static stop() {
    if (rolloverJob) { rolloverJob.stop(); rolloverJob = null; }
    this._initialized = false;
    logger.info("MuharramPeriodScheduler stopped.");
  }
}

export default MuharramPeriodScheduler;
export { rolloverMuharramPeriods };
