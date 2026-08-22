import HotelRateModel from "../models/HotelRateModel.js";
import TransportRateModel from "../models/TransportRateModel.js";
import FlightRateModel from "../models/FlightRateModel.js";
import VisaRateModel from "../models/VisaRateModel.js";
import ServiceRateModel from "../models/ServiceRateModel.js";
import AuditLogModel from "../models/AuditLogmodel.js";
import { publishEvent } from "../utils/eventBus.js";
import { getPackagePricingConfig } from "../utils/packagePricingConfig.js";
import logger from "../utils/logger.js";

// Package Pricing Engine — PRD §26/§110-111 "Rate expiry dashboard/alerts."
// Same structure as services/taxRuleExpiryScheduler.js: cross-tenant query
// (each row's own tenantId travels with it, no tenantId filter needed),
// AuditLogModel entry + publishEvent per transition, node-cron with the
// same lazy-import/graceful-degrade-if-missing pattern.
const RATE_MODELS = [
  { model: HotelRateModel, resource: "HotelRate", label: (r) => `${r.hotelCatalogId}/${r.roomTypeId}` },
  { model: TransportRateModel, resource: "TransportRate", label: (r) => `${r.origin} -> ${r.destination}` },
  { model: FlightRateModel, resource: "FlightRate", label: (r) => r.route },
  { model: VisaRateModel, resource: "VisaRate", label: (r) => `${r.country}/${r.visaType}` },
  { model: ServiceRateModel, resource: "ServiceRate", label: (r) => r.name }
];

async function runPackageRateExpiry() {
  const startTime = Date.now();
  const config = getPackagePricingConfig();
  const now = new Date();
  const warningCutoff = new Date(now.getTime() + config.rateExpiryWarningDays * 86400000);
  let expiredCount = 0;
  let expiringSoonCount = 0;

  try {
    for (const { model, resource, label } of RATE_MODELS) {
      // Already past validTo (HotelRateModel also uses `date` for ExactDate
      // rows) but still Active -> flip to Expired, never deleted.
      const expiredFilter = {
        status: "Active",
        $or: [{ validTo: { $ne: null, $lt: now } }, ...(model === HotelRateModel ? [{ date: { $ne: null, $lt: now } }] : [])]
      };
      const expired = await model.find(expiredFilter);
      for (const rate of expired) {
        rate.status = "Expired";
        await rate.save();
        expiredCount += 1;
        await AuditLogModel.create({ action: "package.pricing.expire_rate", module: "PackagePricing", resource, resourceId: rate._id.toString(), userId: null, tenantId: rate.tenantId, details: { label: label(rate) } });
        publishEvent("PackageRateExpired", { tenantId: rate.tenantId, resource, rateId: rate._id.toString(), label: label(rate) });
      }

      // Still Active but expiring within the configured warning window ->
      // one notification event per rate, no status change (still usable
      // right up until it genuinely expires).
      const expiringSoonFilter = {
        status: "Active",
        $or: [{ validTo: { $gte: now, $lte: warningCutoff } }, ...(model === HotelRateModel ? [{ date: { $gte: now, $lte: warningCutoff } }] : [])]
      };
      const expiringSoon = await model.find(expiringSoonFilter).lean();
      for (const rate of expiringSoon) {
        expiringSoonCount += 1;
        publishEvent("PackageRateExpiringSoon", { tenantId: rate.tenantId, resource, rateId: rate._id.toString(), label: label(rate), expiresAt: rate.validTo || rate.date });
      }
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    logger.info(`Package rate expiry check completed in ${elapsed}s — ${expiredCount} expired, ${expiringSoonCount} expiring within ${config.rateExpiryWarningDays} day(s).`);
  } catch (err) {
    logger.error("Package rate expiry check failed.", { error: err.message });
  }
}

let cronLib = null;
let expiryJob = null;

class PackageRateExpiryScheduler {
  static _initialized = false;

  static async init() {
    if (this._initialized) return;
    this._initialized = true;

    try {
      cronLib = (await import("node-cron")).default;
    } catch (err) {
      logger.warn("node-cron not available — package rate expiry checks disabled.", { error: err.message });
      return;
    }

    const config = getPackagePricingConfig();
    const expr = cronLib.validate(config.rateExpiryCron) ? config.rateExpiryCron : "0 3 * * *";
    if (expr !== config.rateExpiryCron) logger.error(`Invalid PACKAGE_RATE_EXPIRY_CRON_SCHEDULE: "${config.rateExpiryCron}". Falling back to "0 3 * * *".`);

    expiryJob = cronLib.schedule(expr, () => {
      runPackageRateExpiry().catch((err) => logger.error("Cron package rate expiry error", { error: err.message }));
    }, { scheduled: true, timezone: process.env.TZ || undefined });

    logger.info(`PackageRateExpiryScheduler started — schedule: "${expr}".`);
  }

  static stop() {
    if (expiryJob) { expiryJob.stop(); expiryJob = null; }
    this._initialized = false;
    logger.info("PackageRateExpiryScheduler stopped.");
  }
}

export default PackageRateExpiryScheduler;
