import mongoose from "mongoose";
import ReferenceDataService from "./ReferenceDataService.js";
import ReferenceAirportModel from "../models/ReferenceAirportModel.js";
import logger from "../utils/logger.js";
import { getReferenceDataSyncConfig } from "../utils/referenceDataConfig.js";

let cronLib = null;
let syncJob = null;

/**
 * EXT-013 §5 "Reference data is synchronized automatically" (daily). Mirrors
 * AnalyticsScheduler.js's exact node-cron pattern.
 */
class ReferenceDataScheduler {
  static _initialized = false;

  static async init() {
    if (this._initialized) return;
    this._initialized = true;

    try {
      cronLib = (await import("node-cron")).default;
    } catch (err) {
      logger.warn("node-cron not available — reference data sync job disabled.", { error: err.message });
      return;
    }

    const config = getReferenceDataSyncConfig();
    const expr = cronLib.validate(config.cronSchedule) ? config.cronSchedule : "0 3 * * *";
    if (!cronLib.validate(config.cronSchedule)) {
      logger.error(`Invalid REFERENCE_DATA_SYNC_CRON_SCHEDULE: "${config.cronSchedule}". Falling back to 0 3 * * *`);
    }

    syncJob = cronLib.schedule(expr, () => {
      ReferenceDataService.syncAll({ triggeredBy: "scheduler" }).catch((err) => logger.error("Reference data cron sync error", { error: err.message }));
    }, { scheduled: true, timezone: process.env.TZ || undefined });

    logger.info(`ReferenceDataScheduler started — schedule: "${expr}"`);

    // First-boot convenience: a fresh install would otherwise sit with
    // empty master tables until the next 3am run, breaking every consumer
    // (booking dropdowns, AI lookups) in the meantime. Fire-and-forget,
    // never blocks server startup.
    if (mongoose.connection?.readyState === 1) {
      const count = await ReferenceAirportModel.countDocuments().catch(() => 0);
      if (count === 0) {
        logger.info("Reference master tables are empty — triggering an initial sync.");
        ReferenceDataService.syncAll({ triggeredBy: "initial-boot" }).catch((err) => logger.error("Reference data initial sync error", { error: err.message }));
      }
    }
  }

  static stop() {
    if (syncJob) { syncJob.stop(); syncJob = null; }
    this._initialized = false;
    logger.info("ReferenceDataScheduler stopped.");
  }

  static async triggerSync() {
    return ReferenceDataService.syncAll({ triggeredBy: "manual" });
  }
}

export default ReferenceDataScheduler;
