import JournalService from "./JournalService.js";
import { getFinanceConfig } from "../utils/financeConfig.js";
import logger from "../utils/logger.js";
import { withDistributedLock } from "../utils/distributedLock.js";
import { getSchedulerLockConfig } from "../utils/schedulerLockConfig.js";

// "Recurring Journals" — File 2, Journal Platform Part 2, item 19. Real
// cron-based generation, the same proven pattern as every other scheduler
// in this codebase (services/receivableOverdueScheduler.js etc.) — not a
// message-queue/worker-pool system (none exists here; see
// docs/05-api/07-finance-api.md Part 39's own "explicitly out of scope"
// note for why that infrastructure wasn't fabricated for this pass).
async function runRecurringJournals() {
  const startTime = Date.now();
  try {
    const generatedCount = await JournalService.runDueRecurringJournals();
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    logger.info(`Recurring journal generation completed in ${elapsed}s — ${generatedCount} journal(s) generated.`);
  } catch (err) {
    logger.error("Recurring journal generation failed.", { error: err.message });
  }
}

let cronLib = null;
let recurringJob = null;

class RecurringJournalScheduler {
  static _initialized = false;

  static async init() {
    if (this._initialized) return;
    this._initialized = true;

    try {
      cronLib = (await import("node-cron")).default;
    } catch (err) {
      logger.warn("node-cron not available — recurring journal generation disabled.", { error: err.message });
      return;
    }

    const config = getFinanceConfig();
    const expr = cronLib.validate(config.recurringJournalCron) ? config.recurringJournalCron : "0 3 * * *";
    if (expr !== config.recurringJournalCron) logger.error(`Invalid RECURRING_JOURNAL_CRON_SCHEDULE: "${config.recurringJournalCron}". Falling back to "0 3 * * *".`);

    recurringJob = cronLib.schedule(expr, () => {
      // Real money — a duplicate run here means a duplicate journal entry.
      withDistributedLock("scheduler:RecurringJournalScheduler", getSchedulerLockConfig().defaultLockTtlMs, runRecurringJournals)
        .catch((err) => logger.error("Cron recurring journal error", { error: err.message }));
    }, { scheduled: true, timezone: process.env.TZ || undefined });

    logger.info(`RecurringJournalScheduler started — schedule: "${expr}".`);
  }

  static stop() {
    if (recurringJob) { recurringJob.stop(); recurringJob = null; }
    this._initialized = false;
    logger.info("RecurringJournalScheduler stopped.");
  }
}

export default RecurringJournalScheduler;
