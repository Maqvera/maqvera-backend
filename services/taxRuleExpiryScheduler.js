import TaxRuleModel from "../models/TaxRuleModel.js";
import AuditLogModel from "../models/AuditLogmodel.js";
import { publishEvent } from "../utils/eventBus.js";
import { getFinanceConfig } from "../utils/financeConfig.js";
import logger from "../utils/logger.js";
import { withDistributedLock } from "../utils/distributedLock.js";
import { getSchedulerLockConfig } from "../utils/schedulerLockConfig.js";

// Enterprise Tax Engine — Finance Module Part 20. "Tax Versioning...
// Historical Rules, Future Rules, Effective Dates, End Dates. Immutable
// history." Whether an Approved rule is CURRENTLY effective is computed
// at resolution time from its own effectiveDate/endDate (TaxService.resolveApplicableRule),
// not a status this scheduler flips daily — the one real, cron-driven
// job left is firing the named `TaxRuleExpired` event once a rule's own
// endDate has genuinely passed, mirroring receivableOverdueScheduler.js's
// own cross-tenant, no-tenantId-filter query pattern (a rule's own
// tenantId travels with it).
async function runTaxRuleExpiry() {
  const startTime = Date.now();
  try {
    const now = new Date();
    const expired = await TaxRuleModel.find({ status: "Approved", endDate: { $ne: null, $lt: now } });

    for (const rule of expired) {
      rule.status = "Expired";
      rule.timeline.push({ event: "TaxRuleExpired", description: `Past end date ${rule.endDate.toISOString().split("T")[0]}.`, performedBy: "system" });
      await rule.save();

      await AuditLogModel.create({ action: "finance.tax.expire_rule", module: "Finance", resource: "TaxRule", resourceId: rule._id.toString(), userId: null, tenantId: rule.tenantId, details: { endDate: rule.endDate } });
      publishEvent("TaxRuleExpired", { tenantId: rule.tenantId, taxRuleId: rule._id.toString(), taxCode: rule.taxCode, country: rule.country, endDate: rule.endDate });
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    logger.info(`Tax rule expiry check completed in ${elapsed}s — ${expired.length} rule(s) expired.`);
  } catch (err) {
    logger.error("Tax rule expiry check failed.", { error: err.message });
  }
}

let cronLib = null;
let expiryJob = null;

class TaxRuleExpiryScheduler {
  static _initialized = false;

  static async init() {
    if (this._initialized) return;
    this._initialized = true;

    try {
      cronLib = (await import("node-cron")).default;
    } catch (err) {
      logger.warn("node-cron not available — tax rule expiry checks disabled.", { error: err.message });
      return;
    }

    const config = getFinanceConfig();
    const expr = cronLib.validate(config.taxRuleExpiryCron) ? config.taxRuleExpiryCron : "0 2 1 * *";
    if (expr !== config.taxRuleExpiryCron) logger.error(`Invalid TAX_RULE_EXPIRY_CRON_SCHEDULE: "${config.taxRuleExpiryCron}". Falling back to "0 2 1 * *".`);

    expiryJob = cronLib.schedule(expr, () => {
      withDistributedLock("scheduler:TaxRuleExpiryScheduler", getSchedulerLockConfig().defaultLockTtlMs, runTaxRuleExpiry)
        .catch((err) => logger.error("Cron tax rule expiry error", { error: err.message }));
    }, { scheduled: true, timezone: process.env.TZ || undefined });

    logger.info(`TaxRuleExpiryScheduler started — schedule: "${expr}".`);
  }

  static stop() {
    if (expiryJob) { expiryJob.stop(); expiryJob = null; }
    this._initialized = false;
    logger.info("TaxRuleExpiryScheduler stopped.");
  }
}

export default TaxRuleExpiryScheduler;
