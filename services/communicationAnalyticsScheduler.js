import mongoose from "mongoose";
import CommunicationAnalyticsEngine from "./CommunicationAnalyticsEngine.js";
import logger from "../utils/logger.js";

// Same division of responsibility as every other *Scheduler.js in this
// codebase (analyticsScheduler.js, webhookRetryScheduler.js,
// aiApprovalTimeoutScheduler.js) — a thin cron wrapper; the actual
// aggregation logic lives in CommunicationAnalyticsEngine itself, which is
// also independently triggered by real domain events (delivered/failed/
// provider-switched) via its own init(). This sweep is the backstop for
// tenants with no recent communication activity to trigger an event-driven
// refresh, so their summary still exists and isn't stuck on "pendingRefresh".
const COMMUNICATION_ANALYTICS_CRON = process.env.COMMUNICATION_ANALYTICS_CRON_SCHEDULE || "*/10 * * * *";

async function getActiveTenants() {
  if (mongoose.connection.readyState !== 1) return [];
  try {
    const UserModel = mongoose.model("user");
    const tenants = await UserModel.distinct("tenantId", { status: "active", tenantId: { $ne: null } });
    return tenants.filter(Boolean);
  } catch {
    return [];
  }
}

async function runCommunicationAnalyticsSweep() {
  const startTime = Date.now();
  try {
    const tenants = await getActiveTenants();
    if (tenants.length === 0) return;

    let refreshed = 0;
    for (const tenantId of tenants) {
      try {
        await CommunicationAnalyticsEngine.refreshSummary({ tenantId });
        refreshed += 1;
      } catch (err) {
        logger.error(`Communication analytics refresh failed for tenant ${tenantId}`, { error: err.message });
      }
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    logger.info(`Communication analytics sweep completed in ${elapsed}s — ${refreshed}/${tenants.length} tenant(s) refreshed.`);
  } catch (err) {
    logger.error("Communication analytics sweep critical failure.", { error: err.message });
  }
}

let cronLib = null;
let sweepJob = null;

class CommunicationAnalyticsScheduler {
  static _initialized = false;

  static async init() {
    if (this._initialized) return;
    this._initialized = true;

    try {
      cronLib = (await import("node-cron")).default;
    } catch (err) {
      logger.warn("node-cron not available — Communication analytics sweeps disabled.", { error: err.message });
      return;
    }

    const expr = cronLib.validate(COMMUNICATION_ANALYTICS_CRON) ? COMMUNICATION_ANALYTICS_CRON : "*/10 * * * *";
    if (expr !== COMMUNICATION_ANALYTICS_CRON) logger.error(`Invalid COMMUNICATION_ANALYTICS_CRON_SCHEDULE: "${COMMUNICATION_ANALYTICS_CRON}". Falling back to "*/10 * * * *".`);

    sweepJob = cronLib.schedule(expr, () => {
      runCommunicationAnalyticsSweep().catch((err) => logger.error("Cron Communication analytics sweep error", { error: err.message }));
    }, { scheduled: true, timezone: process.env.TZ || undefined });

    logger.info(`CommunicationAnalyticsScheduler started — schedule: "${expr}".`);
  }

  static stop() {
    if (sweepJob) { sweepJob.stop(); sweepJob = null; }
    this._initialized = false;
    logger.info("CommunicationAnalyticsScheduler stopped.");
  }
}

export default CommunicationAnalyticsScheduler;
