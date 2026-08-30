import FlightScheduleSyncService from "./FlightScheduleSyncService.js";
import logger from "../utils/logger.js";
import { getFlightScheduleSyncPolicy } from "../utils/gdsConfig.js";
import { withDistributedLock } from "../utils/distributedLock.js";
import { getSchedulerLockConfig } from "../utils/schedulerLockConfig.js";

let cronLib = null;
let standardJob = null;
let highPriorityJob = null;

/**
 * EXT-018 §6 "Scheduler Configuration — Frequency Every 15 Minutes
 * (Configurable), High Priority Flights Every 5 Minutes, Completed/
 * Cancelled Flights Ignored." Mirrors AnalyticsScheduler.js's exact
 * node-cron pattern, with two tiers instead of one.
 */
class FlightScheduleSyncScheduler {
  static _initialized = false;

  static async init() {
    if (this._initialized) return;
    this._initialized = true;

    try {
      cronLib = (await import("node-cron")).default;
    } catch (err) {
      logger.warn("node-cron not available — flight schedule sync job disabled.", { error: err.message });
      return;
    }

    const config = getFlightScheduleSyncPolicy();
    const standardExpr = cronLib.validate(config.cronSchedule) ? config.cronSchedule : "*/15 * * * *";
    if (!cronLib.validate(config.cronSchedule)) {
      logger.error(`Invalid FLIGHT_SCHEDULE_SYNC_CRON_SCHEDULE: "${config.cronSchedule}". Falling back to */15 * * * *`);
    }
    const highPriorityExpr = cronLib.validate(config.highPriorityCronSchedule) ? config.highPriorityCronSchedule : "*/5 * * * *";
    if (!cronLib.validate(config.highPriorityCronSchedule)) {
      logger.error(`Invalid FLIGHT_SCHEDULE_SYNC_HIGH_PRIORITY_CRON_SCHEDULE: "${config.highPriorityCronSchedule}". Falling back to */5 * * * *`);
    }

    standardJob = cronLib.schedule(standardExpr, () => {
      withDistributedLock("scheduler:FlightScheduleSyncScheduler:standard", getSchedulerLockConfig().defaultLockTtlMs, () => FlightScheduleSyncService.runSyncCycle({ tier: "standard", triggeredBy: "scheduler" }))
        .catch((err) => logger.error("Flight schedule sync (standard) cron error", { error: err.message }));
    }, { scheduled: true, timezone: process.env.TZ || undefined });

    highPriorityJob = cronLib.schedule(highPriorityExpr, () => {
      withDistributedLock("scheduler:FlightScheduleSyncScheduler:highPriority", getSchedulerLockConfig().defaultLockTtlMs, () => FlightScheduleSyncService.runSyncCycle({ tier: "high", triggeredBy: "scheduler" }))
        .catch((err) => logger.error("Flight schedule sync (high-priority) cron error", { error: err.message }));
    }, { scheduled: true, timezone: process.env.TZ || undefined });

    logger.info(`FlightScheduleSyncScheduler started — standard: "${standardExpr}", high-priority: "${highPriorityExpr}"`);
  }

  static stop() {
    if (standardJob) { standardJob.stop(); standardJob = null; }
    if (highPriorityJob) { highPriorityJob.stop(); highPriorityJob = null; }
    this._initialized = false;
    logger.info("FlightScheduleSyncScheduler stopped.");
  }

  /** §5 "Trigger Sources — Manual Sync, Booking Refresh, Travel Dashboard, Operations Screen, AI Assistant." */
  static async triggerSync({ tier = "standard" } = {}) {
    return FlightScheduleSyncService.runSyncCycle({ tier, triggeredBy: "manual" });
  }
}

export default FlightScheduleSyncScheduler;
