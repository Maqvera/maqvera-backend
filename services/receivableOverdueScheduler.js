import AccountsReceivableModel from "../models/AccountsReceivableModel.js";
import AuditLogModel from "../models/AuditLogmodel.js";
import { publishEvent } from "../utils/eventBus.js";
import { getFinanceConfig } from "../utils/financeConfig.js";
import logger from "../utils/logger.js";

const DAY_MS = 24 * 60 * 60 * 1000;

// "Automatic Reminder -> Email -> SMS -> WhatsApp -> Phone Call ->
// Management Escalation" (Dunning Rules) mapped onto the collection-stage
// progression (Reminder -> Follow-up -> Supervisor Review -> Collection
// Team -> Legal Action) so each escalation names the channel it would use.
const STAGE_CHANNEL = {
  Reminder: "Email",
  "Follow-up": "SMS",
  "Supervisor Review": "WhatsApp",
  "Collection Team": "Phone Call",
  "Legal Action": "Management Escalation"
};

/**
 * "Open -> Reminder -> Follow-up -> Supervisor Review -> Collection Team ->
 * Legal Action (Optional) -> Write Off" — flags Open/Partially Paid
 * receivables that have passed their due date as Overdue.
 */
async function markOverdueReceivables() {
  const now = new Date();
  const overdue = await AccountsReceivableModel.find({
    status: { $in: ["Open", "Partially Paid"] },
    dueDate: { $lt: now }
  });

  for (const receivable of overdue) {
    receivable.status = "Overdue";
    receivable.timeline.push({ event: "ReceivableOverdue", description: `Past due date ${receivable.dueDate.toISOString().split("T")[0]}.`, performedBy: "system" });
    await receivable.save();

    await AuditLogModel.create({
      action: "finance.receivable.overdue",
      module: "Finance",
      resource: "AccountsReceivable",
      resourceId: receivable._id.toString(),
      userId: null,
      tenantId: receivable.tenantId,
      details: { dueDate: receivable.dueDate }
    });

    publishEvent("ReceivableOverdue", { tenantId: receivable.tenantId, receivableId: receivable._id.toString(), customerId: receivable.customerId.toString(), invoiceNumber: receivable.invoiceNumber, outstandingBalance: receivable.outstandingBalance });
  }

  return overdue.length;
}

/**
 * Escalates Overdue/In Collection receivables through the configured
 * collection stages based on days-past-due, publishing NotificationRequested
 * for dunning (never claiming an actual email/SMS/WhatsApp was sent — no
 * notification provider is wired up anywhere in this codebase, same
 * disclosed limitation as documentExpiryScheduler.js's own reminders).
 * Reaching the first stage promotes the receivable's own status from
 * Overdue to "In Collection" and fires CollectionStarted.
 */
async function escalateCollections() {
  const config = getFinanceConfig();
  const stages = [...config.collectionStages].sort((a, b) => a.afterDaysOverdue - b.afterDaysOverdue);
  if (stages.length === 0) return 0;

  const now = new Date();
  const candidates = await AccountsReceivableModel.find({
    status: { $in: ["Overdue", "In Collection"] },
    dueDate: { $lt: now }
  });

  let escalatedCount = 0;
  for (const receivable of candidates) {
    const daysOverdue = Math.floor((now.getTime() - receivable.dueDate.getTime()) / DAY_MS);
    const eligibleStage = [...stages].reverse().find((s) => daysOverdue >= s.afterDaysOverdue);
    if (!eligibleStage || eligibleStage.stage === receivable.collectionStage) continue;

    const enteringCollection = receivable.status === "Overdue";
    receivable.collectionStage = eligibleStage.stage;
    if (enteringCollection) receivable.status = "In Collection";
    receivable.timeline.push({ event: "CollectionStageChanged", description: `Collection stage advanced to "${eligibleStage.stage}" (${daysOverdue} days overdue).`, performedBy: "system" });
    await receivable.save();
    escalatedCount += 1;

    if (enteringCollection) {
      publishEvent("CollectionStarted", { tenantId: receivable.tenantId, receivableId: receivable._id.toString(), customerId: receivable.customerId.toString(), invoiceNumber: receivable.invoiceNumber, daysOverdue });
    }

    publishEvent("NotificationRequested", {
      tenantId: receivable.tenantId,
      event: "ReceivableCollectionEscalated",
      priority: eligibleStage.stage === "Legal Action" ? "high" : "normal",
      referenceId: receivable._id.toString(),
      customerId: receivable.customerId.toString(),
      collectionStage: eligibleStage.stage,
      channel: STAGE_CHANNEL[eligibleStage.stage] || "Email",
      daysOverdue
    });
  }

  return escalatedCount;
}

async function runOverdueCheck() {
  const startTime = Date.now();
  try {
    const [overdueCount, escalatedCount] = await Promise.all([markOverdueReceivables(), escalateCollections()]);
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    logger.info(`Receivable overdue check completed in ${elapsed}s — ${overdueCount} newly overdue, ${escalatedCount} collection escalations.`);
  } catch (err) {
    logger.error("Receivable overdue check failed.", { error: err.message });
  }
}

let cronLib = null;
let overdueJob = null;

class ReceivableOverdueScheduler {
  static _initialized = false;

  static async init() {
    if (this._initialized) return;
    this._initialized = true;

    try {
      cronLib = (await import("node-cron")).default;
    } catch (err) {
      logger.warn("node-cron not available — receivable overdue checks disabled.", { error: err.message });
      return;
    }

    const config = getFinanceConfig();
    const expr = cronLib.validate(config.overdueCheckCron) ? config.overdueCheckCron : "0 4 * * *";
    if (expr !== config.overdueCheckCron) logger.error(`Invalid AR_OVERDUE_CRON_SCHEDULE: "${config.overdueCheckCron}". Falling back to "0 4 * * *".`);

    overdueJob = cronLib.schedule(expr, () => {
      runOverdueCheck().catch((err) => logger.error("Cron receivable overdue error", { error: err.message }));
    }, { scheduled: true, timezone: process.env.TZ || undefined });

    logger.info(`ReceivableOverdueScheduler started — schedule: "${expr}".`);
  }

  static stop() {
    if (overdueJob) { overdueJob.stop(); overdueJob = null; }
    this._initialized = false;
    logger.info("ReceivableOverdueScheduler stopped.");
  }
}

export default ReceivableOverdueScheduler;
