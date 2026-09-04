import mongoose from "mongoose";
import KPIEngine from "./KPIEngine.js";
import CacheManager from "../utils/cacheManager.js";
import logger from "../utils/logger.js";
import { withDistributedLock } from "../utils/distributedLock.js";
import { getSchedulerLockConfig } from "../utils/schedulerLockConfig.js";

// ─────────────────────────────────────────────────────────────
// Configuration — all from environment
// ─────────────────────────────────────────────────────────────
const INCREMENTAL_CRON = process.env.ANALYTICS_CRON_SCHEDULE || "*/5 * * * *";
const NIGHTLY_CRON = process.env.ANALYTICS_NIGHTLY_CRON_SCHEDULE || "0 2 * * *";

let cronLib = null;
let incrementalJob = null;
let nightlyJob = null;

/**
 * Discover all distinct tenantIds currently in the database.
 * Avoids hardcoding any tenant list.
 */
async function getActiveTenants() {
  if (mongoose.connection.readyState !== 1) return [];
  try {
    // Use a lightweight model to find distinct tenantIds
    const UserModel = mongoose.model("user");
    const tenants = await UserModel.distinct("tenantId", { status: "active", tenantId: { $ne: null } });
    return tenants.filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Incremental refresh — runs every N minutes.
 * Refreshes KPIs for all active tenants.
 */
async function incrementalRefresh() {
  const startTime = Date.now();
  logger.info("Analytics incremental refresh started.");

  try {
    const tenants = await getActiveTenants();
    if (tenants.length === 0) {
      logger.info("No active tenants found — skipping incremental refresh.");
      return;
    }

    // Process tenants sequentially to avoid overwhelming the DB
    for (const tenantId of tenants) {
      try {
        await KPIEngine.refreshAllForTenant({ tenantId });
      } catch (err) {
        logger.error(`Incremental refresh failed for tenant ${tenantId}`, { error: err.message });
      }
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    logger.info(`Analytics incremental refresh completed. ${tenants.length} tenant(s) processed in ${elapsed}s.`);
  } catch (err) {
    logger.error("Analytics incremental refresh critical failure.", { error: err.message });
  }
}

/**
 * Nightly rebuild — full cache flush + recomputation.
 */
async function nightlyRebuild() {
  const startTime = Date.now();
  logger.info("Analytics nightly full rebuild started.");

  try {
    // Flush all dashboard caches
    await CacheManager.flush();

    const tenants = await getActiveTenants();
    for (const tenantId of tenants) {
      try {
        await KPIEngine.refreshAllForTenant({ tenantId });
      } catch (err) {
        logger.error(`Nightly rebuild failed for tenant ${tenantId}`, { error: err.message });
      }
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    logger.info(`Analytics nightly rebuild completed. ${tenants.length} tenant(s) in ${elapsed}s.`);
  } catch (err) {
    logger.error("Analytics nightly rebuild critical failure.", { error: err.message });
  }
}

// ─────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────
class AnalyticsScheduler {
  static _initialized = false;

  /**
   * Start the background cron jobs.
   * Safe to call multiple times — only starts once.
   */
  static async init() {
    if (this._initialized) return;
    this._initialized = true;

    try {
      cronLib = (await import("node-cron")).default;
    } catch (err) {
      logger.warn("node-cron not available — background analytics jobs disabled.", { error: err.message });
      return;
    }

    // Validate cron expressions
    if (!cronLib.validate(INCREMENTAL_CRON)) {
      logger.error(`Invalid ANALYTICS_CRON_SCHEDULE: "${INCREMENTAL_CRON}". Falling back to */5 * * * *`);
    }
    if (!cronLib.validate(NIGHTLY_CRON)) {
      logger.error(`Invalid ANALYTICS_NIGHTLY_CRON_SCHEDULE: "${NIGHTLY_CRON}". Falling back to 0 2 * * *`);
    }

    const incrementalExpr = cronLib.validate(INCREMENTAL_CRON) ? INCREMENTAL_CRON : "*/5 * * * *";
    const nightlyExpr = cronLib.validate(NIGHTLY_CRON) ? NIGHTLY_CRON : "0 2 * * *";

    incrementalJob = cronLib.schedule(incrementalExpr, () => {
      withDistributedLock("scheduler:AnalyticsScheduler:incremental", getSchedulerLockConfig().defaultLockTtlMs, incrementalRefresh)
        .catch((err) => logger.error("Cron incremental error", { error: err.message }));
    }, { scheduled: true, timezone: process.env.TZ || undefined });

    nightlyJob = cronLib.schedule(nightlyExpr, () => {
      withDistributedLock("scheduler:AnalyticsScheduler:nightly", getSchedulerLockConfig().defaultLockTtlMs, nightlyRebuild)
        .catch((err) => logger.error("Cron nightly error", { error: err.message }));
    }, { scheduled: true, timezone: process.env.TZ || undefined });

    logger.info(`AnalyticsScheduler started — incremental: "${incrementalExpr}", nightly: "${nightlyExpr}"`);
  }

  /**
   * Stop all scheduled jobs gracefully.
   */
  static stop() {
    if (incrementalJob) { incrementalJob.stop(); incrementalJob = null; }
    if (nightlyJob) { nightlyJob.stop(); nightlyJob = null; }
    this._initialized = false;
    logger.info("AnalyticsScheduler stopped.");
  }

  /**
   * Trigger an immediate refresh for a specific tenant (useful for event-driven updates).
   */
  static async triggerRefresh({ tenantId }) {
    if (!tenantId) return;
    try {
      await KPIEngine.refreshAllForTenant({ tenantId });
    } catch (err) {
      logger.error("On-demand analytics refresh failed.", { tenantId, error: err.message });
    }
  }
}

export default AnalyticsScheduler;
