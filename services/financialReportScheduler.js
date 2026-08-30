import ReportScheduleModel from "../models/ReportScheduleModel.js";
import FinancialReportModel from "../models/FinancialReportModel.js";
import FinancialReportService from "./FinancialReportService.js";
import FinancialReportExportService from "./FinancialReportExportService.js";
import { getDeliveryAdapter } from "./delivery/index.js";
import AuditLogModel from "../models/AuditLogmodel.js";
import TenantSubscriptionService from "./TenantSubscriptionService.js";
import { publishEvent } from "../utils/eventBus.js";
import { getFinanceConfig } from "../utils/financeConfig.js";
import logger from "../utils/logger.js";
import { withDistributedLock } from "../utils/distributedLock.js";
import { getSchedulerLockConfig } from "../utils/schedulerLockConfig.js";

// Enterprise Financial Reporting — Finance Module Part 24. "Report
// Scheduling... Daily, Weekly, Monthly, Quarterly, Yearly." Real,
// cron-driven — generates the report fresh (never replays stale figures),
// exports it, and emails it via Part 8's own real
// `services/delivery/EmailDeliveryAdapter.js`. Mirrors
// receivableOverdueScheduler.js's own cross-tenant, no-tenantId-filter
// query pattern (a schedule's own tenantId travels with it).

const FREQUENCY_MS = { Daily: 24, Weekly: 24 * 7, Monthly: 24 * 30, Quarterly: 24 * 91, Yearly: 24 * 365 };

const computeNextRunAt = (frequency, from = new Date()) => new Date(from.getTime() + (FREQUENCY_MS[frequency] || 24) * 60 * 60 * 1000);

async function runDueSchedules() {
  const startTime = Date.now();
  try {
    const now = new Date();
    const due = await ReportScheduleModel.find({ status: "Active", nextRunAt: { $lte: now } });

    let ranCount = 0;
    let skippedSuspended = 0;
    for (const schedule of due) {
      try {
        // Enterprise Access Revocation Engine (Automation #5) — "Background
        // Services... Scheduled Reports MUST stop." Real, reuses the exact
        // same cached enforcement check every HTTP request already goes
        // through (middleware/authenticateAccessToken.js) — no new
        // suspension-detection mechanism, no per-tenant special-casing.
        // Proof-of-pattern on this one scheduler; retrofitting the same
        // one-line guard onto every other cross-tenant scheduler in this
        // codebase is real, deliberate, incremental Adoption work (see
        // docs/07-enterprise-standards-equivalent doc for this automation).
        const block = await TenantSubscriptionService.getEnforcementBlock(schedule.tenantId);
        if (block) { skippedSuspended += 1; continue; }

        const report = await FinancialReportService.generateReport({ reportType: schedule.reportType, ...schedule.parameters }, schedule.tenantId, "system");
        const reportDoc = await FinancialReportModel.findOne({ _id: report._id, tenantId: schedule.tenantId });
        const exportResult = await FinancialReportExportService.exportAndStore(reportDoc, schedule.format, schedule.tenantId);
        reportDoc.exports.push(exportResult);
        await reportDoc.save();

        publishEvent("ReportScheduled", { tenantId: schedule.tenantId, scheduleId: schedule._id.toString(), reportId: report._id.toString(), performedBy: "system" });

        const adapter = getDeliveryAdapter("Email");
        if (adapter && schedule.recipientEmails.length > 0) {
          for (const email of schedule.recipientEmails) {
            const result = await adapter.send({ to: email, subject: `${schedule.reportType} Report — ${schedule.name}`, body: `Your scheduled ${schedule.reportType} report is ready.`, attachment: null, receiptNumber: null, verificationUrl: exportResult.url });
            if (result.status === "Sent") {
              publishEvent("ReportDelivered", { tenantId: schedule.tenantId, scheduleId: schedule._id.toString(), reportId: report._id.toString(), email, performedBy: "system" });
            }
          }
        }

        schedule.lastRunAt = now;
        schedule.nextRunAt = computeNextRunAt(schedule.frequency, now);
        await schedule.save();
        ranCount += 1;

        await AuditLogModel.create({ action: "finance.report.run_schedule", module: "Finance", resource: "ReportSchedule", resourceId: schedule._id.toString(), userId: null, tenantId: schedule.tenantId, details: { reportId: report._id.toString() } });
      } catch (err) {
        logger.error(`Report schedule ${schedule._id} failed.`, { error: err.message });
      }
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    logger.info(`Financial report schedule check completed in ${elapsed}s — ${ranCount}/${due.length} schedule(s) ran${skippedSuspended > 0 ? `, ${skippedSuspended} skipped (tenant suspended)` : ""}.`);
  } catch (err) {
    logger.error("Financial report schedule check failed.", { error: err.message });
  }
}

/** Real, cron-driven expiry — marks a Generated report past its own `expiresAt` as Expired. */
async function runReportExpiry() {
  try {
    const now = new Date();
    const result = await FinancialReportModel.updateMany({ status: "Generated", expiresAt: { $ne: null, $lt: now } }, { $set: { status: "Expired" } });
    if (result.modifiedCount > 0) logger.info(`Expired ${result.modifiedCount} financial report(s) past their retention period.`);
  } catch (err) {
    logger.error("Financial report expiry check failed.", { error: err.message });
  }
}

let cronLib = null;
let scheduleJob = null;

class FinancialReportScheduler {
  static _initialized = false;

  static async init() {
    if (this._initialized) return;
    this._initialized = true;

    try {
      cronLib = (await import("node-cron")).default;
    } catch (err) {
      logger.warn("node-cron not available — financial report scheduling disabled.", { error: err.message });
      return;
    }

    const config = getFinanceConfig();
    const expr = cronLib.validate(config.reportScheduleCron) ? config.reportScheduleCron : "0 5 * * *";
    if (expr !== config.reportScheduleCron) logger.error(`Invalid REPORT_SCHEDULE_CRON_SCHEDULE: "${config.reportScheduleCron}". Falling back to "0 5 * * *".`);

    scheduleJob = cronLib.schedule(expr, () => {
      const ttlMs = getSchedulerLockConfig().defaultLockTtlMs;
      withDistributedLock("scheduler:FinancialReportScheduler:dueSchedules", ttlMs, runDueSchedules)
        .catch((err) => logger.error("Cron financial report schedule error", { error: err.message }));
      withDistributedLock("scheduler:FinancialReportScheduler:reportExpiry", ttlMs, runReportExpiry)
        .catch((err) => logger.error("Cron financial report expiry error", { error: err.message }));
    }, { scheduled: true, timezone: process.env.TZ || undefined });

    logger.info(`FinancialReportScheduler started — schedule: "${expr}".`);
  }

  static stop() {
    if (scheduleJob) { scheduleJob.stop(); scheduleJob = null; }
    this._initialized = false;
    logger.info("FinancialReportScheduler stopped.");
  }
}

export default FinancialReportScheduler;
