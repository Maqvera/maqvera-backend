import PricingRuleModel from "../models/PricingRuleModel.js";
import AuditLogModel from "../models/AuditLogmodel.js";
import { publishEvent } from "../utils/eventBus.js";
import { getFinanceConfig } from "../utils/financeConfig.js";
import logger from "../utils/logger.js";
import { withDistributedLock } from "../utils/distributedLock.js";
import { getSchedulerLockConfig } from "../utils/schedulerLockConfig.js";

// Enterprise Discount & Pricing Engine — Finance Module Part 21. "Rule
// Versioning... Effective Dates, End Dates." Mirrors Part 20's own
// taxRuleExpiryScheduler.js exactly — whether an Approved rule is
// CURRENTLY effective is computed at resolution time from its own
// effectiveDate/endDate, not a status this scheduler flips daily; the
// one real job left is firing the named `RuleExpired` event (and, for
// Promotion-type rules specifically, the also-named `PromotionEnded`)
// once a rule's own endDate has genuinely passed.
async function runPricingRuleExpiry() {
  const startTime = Date.now();
  try {
    const now = new Date();
    const expired = await PricingRuleModel.find({ status: "Approved", endDate: { $ne: null, $lt: now } });

    for (const rule of expired) {
      rule.status = "Expired";
      rule.timeline.push({ event: "RuleExpired", description: `Past end date ${rule.endDate.toISOString().split("T")[0]}.`, performedBy: "system" });
      await rule.save();

      await AuditLogModel.create({ action: "finance.pricing.expire_rule", module: "Finance", resource: "PricingRule", resourceId: rule._id.toString(), userId: null, tenantId: rule.tenantId, details: { endDate: rule.endDate } });
      publishEvent("RuleExpired", { tenantId: rule.tenantId, ruleId: rule._id.toString(), ruleName: rule.ruleName, ruleType: rule.ruleType, endDate: rule.endDate });
      if (rule.ruleType === "Promotion") {
        publishEvent("PromotionEnded", { tenantId: rule.tenantId, ruleId: rule._id.toString(), ruleName: rule.ruleName, promotionType: rule.promotionType, endDate: rule.endDate });
      }
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    logger.info(`Pricing rule expiry check completed in ${elapsed}s — ${expired.length} rule(s) expired.`);
  } catch (err) {
    logger.error("Pricing rule expiry check failed.", { error: err.message });
  }
}

let cronLib = null;
let expiryJob = null;

class PricingRuleExpiryScheduler {
  static _initialized = false;

  static async init() {
    if (this._initialized) return;
    this._initialized = true;

    try {
      cronLib = (await import("node-cron")).default;
    } catch (err) {
      logger.warn("node-cron not available — pricing rule expiry checks disabled.", { error: err.message });
      return;
    }

    const config = getFinanceConfig();
    const expr = cronLib.validate(config.pricingRuleExpiryCron) ? config.pricingRuleExpiryCron : "0 3 1 * *";
    if (expr !== config.pricingRuleExpiryCron) logger.error(`Invalid PRICING_RULE_EXPIRY_CRON_SCHEDULE: "${config.pricingRuleExpiryCron}". Falling back to "0 3 1 * *".`);

    expiryJob = cronLib.schedule(expr, () => {
      withDistributedLock("scheduler:PricingRuleExpiryScheduler", getSchedulerLockConfig().defaultLockTtlMs, runPricingRuleExpiry)
        .catch((err) => logger.error("Cron pricing rule expiry error", { error: err.message }));
    }, { scheduled: true, timezone: process.env.TZ || undefined });

    logger.info(`PricingRuleExpiryScheduler started — schedule: "${expr}".`);
  }

  static stop() {
    if (expiryJob) { expiryJob.stop(); expiryJob = null; }
    this._initialized = false;
    logger.info("PricingRuleExpiryScheduler stopped.");
  }
}

export default PricingRuleExpiryScheduler;
