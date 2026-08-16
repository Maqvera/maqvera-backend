import AuditComplianceService from "./AuditComplianceService.js";
import { getFinanceConfig } from "../utils/financeConfig.js";
import logger from "../utils/logger.js";

// Enterprise Audit & Compliance — Finance Module Part 27. "Data
// Retention... 7 Years, 10 Years, Unlimited, Legal Hold." Real,
// cron-driven expiry — mirrors financialReportScheduler.js's own
// runReportExpiry pattern exactly (one cross-tenant bulk update, no
// per-tenant loop needed since every AuditEventModel row already carries
// its own tenantId/expiresAt/legalHold).
async function runRetentionCheck() {
  const startTime = Date.now();
  try {
    const archivedCount = await AuditComplianceService.archiveExpiredEvents();
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    logger.info(`Audit retention check completed in ${elapsed}s — ${archivedCount} event(s) archived.`);
  } catch (err) {
    logger.error("Audit retention check failed.", { error: err.message });
  }
}

let cronLib = null;
let retentionJob = null;

class AuditRetentionScheduler {
  static _initialized = false;

  static async init() {
    if (this._initialized) return;
    this._initialized = true;

    try {
      cronLib = (await import("node-cron")).default;
    } catch (err) {
      logger.warn("node-cron not available — audit retention checks disabled.", { error: err.message });
      return;
    }

    const config = getFinanceConfig();
    const expr = cronLib.validate(config.auditRetentionCron) ? config.auditRetentionCron : "0 3 * * *";
    if (expr !== config.auditRetentionCron) logger.error(`Invalid AUDIT_RETENTION_CRON_SCHEDULE: "${config.auditRetentionCron}". Falling back to "0 3 * * *".`);

    retentionJob = cronLib.schedule(expr, () => {
      runRetentionCheck().catch((err) => logger.error("Cron audit retention error", { error: err.message }));
    }, { scheduled: true, timezone: process.env.TZ || undefined });

    logger.info(`AuditRetentionScheduler started — schedule: "${expr}".`);
  }

  static stop() {
    if (retentionJob) { retentionJob.stop(); retentionJob = null; }
    this._initialized = false;
    logger.info("AuditRetentionScheduler stopped.");
  }
}

export default AuditRetentionScheduler;
