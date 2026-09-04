import mongoose from "mongoose";
import TravelIncidentManagementModel from "../models/TravelIncidentManagementModel.js";
import VisaCaseModel from "../models/VisaCaseModel.js";
import { publishEvent } from "../utils/eventBus.js";
import { getIncidentConfig } from "../utils/incidentConfig.js";
import logger from "../utils/logger.js";
import { withDistributedLock } from "../utils/distributedLock.js";
import { getSchedulerLockConfig } from "../utils/schedulerLockConfig.js";

const incidentConfig = getIncidentConfig();

// ─────────────────────────────────────────────────────────────
// Configuration — all from environment
// ─────────────────────────────────────────────────────────────
const SLA_SWEEP_CRON = process.env.INCIDENT_SLA_SWEEP_CRON_SCHEDULE || "*/10 * * * *";
const TERMINAL_STATUSES = ["resolved", "verified", "closed", "rejected", "duplicate"];

let cronLib = null;
let slaJob = null;

/**
 * "SLA Management ... First Response Time." slaStatus.firstResponseBreached
 * was a real schema field but was previously only ever set retroactively
 * inside assignIncident/resolveIncident — an incident nobody ever touched
 * again just sat "on time" forever, even long after its due date passed.
 */
async function sweepFirstResponseBreaches() {
  const now = new Date();
  const incidents = await TravelIncidentManagementModel.find({
    status: { $nin: TERMINAL_STATUSES },
    "slaStatus.firstResponseCompletedAt": null,
    "slaStatus.firstResponseBreached": false,
    "slaStatus.firstResponseDueDate": { $ne: null, $lte: now },
    isSoftDeleted: false
  });

  let count = 0;
  for (const inc of incidents) {
    inc.slaStatus.firstResponseBreached = true;
    inc.slaStatus.isViolated = true;
    await inc.save();
    count += 1;

    publishEvent("NotificationRequested", {
      tenantId: inc.tenantId,
      event: "IncidentFirstResponseSlaBreached",
      priority: "high",
      recipientTeam: inc.assignedTeam,
      recipientId: inc.assignedTo,
      incidentId: inc._id,
      incidentNumber: inc.incidentNumber
    });
  }
  return count;
}

/**
 * "Escalation Chain: Officer -> Supervisor -> Branch Manager -> Operations
 * Manager -> Executive Dashboard ... Escalation configurable." Had zero
 * automation — an incident that breached its resolution SLA was never
 * pushed up the chain, never re-notified, and IncidentEscalated only ever
 * fired from a human manually raising severity via PATCH. Walks
 * incidentConfig.escalationChain one tier per sweep per still-breaching
 * incident, capped at the chain's last tier, and only re-publishes once per
 * tier change (not every sweep) to avoid notification spam.
 */
async function sweepResolutionBreachesAndEscalate() {
  const now = new Date();
  const chain = incidentConfig.escalationChain;
  const incidents = await TravelIncidentManagementModel.find({
    status: { $nin: TERMINAL_STATUSES },
    "slaStatus.resolutionCompletedAt": null,
    "slaStatus.resolutionDueDate": { $ne: null, $lte: now },
    isSoftDeleted: false
  });

  let escalatedCount = 0;
  for (const inc of incidents) {
    inc.slaStatus.resolutionBreached = true;
    inc.slaStatus.isViolated = true;

    const previousLevel = inc.escalationLevel || 0;
    const nextLevel = Math.min(previousLevel + 1, chain.length - 1);
    const didEscalate = nextLevel > previousLevel;
    inc.escalationLevel = nextLevel;

    await inc.save();

    if (!didEscalate) continue;
    escalatedCount += 1;
    const tier = chain[nextLevel];

    if (inc.visaCaseId) {
      const visaCase = await VisaCaseModel.findOne({ _id: inc.visaCaseId, tenantId: inc.tenantId }).catch(() => null);
      if (visaCase) {
        visaCase.timeline.push({
          event: "IncidentEscalated",
          description: `Incident ${inc.incidentNumber} escalated to ${tier} — resolution SLA breached.`,
          performedBy: "system",
          timestamp: now
        });
        await visaCase.save();
      }
    }

    publishEvent("IncidentEscalated", {
      incidentId: inc._id,
      incidentNumber: inc.incidentNumber,
      tenantId: inc.tenantId,
      escalationTier: tier,
      escalationLevel: nextLevel
    });

    publishEvent("NotificationRequested", {
      tenantId: inc.tenantId,
      event: "IncidentEscalated",
      priority: "immediate",
      recipientTier: tier,
      incidentId: inc._id,
      incidentNumber: inc.incidentNumber
    });
  }
  return escalatedCount;
}

async function runIncidentSlaSweep() {
  if (mongoose.connection?.readyState !== 1) return;
  const startTime = Date.now();
  try {
    const [firstResponseCount, escalatedCount] = await Promise.all([
      sweepFirstResponseBreaches(),
      sweepResolutionBreachesAndEscalate()
    ]);
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    logger.info(`Incident SLA sweep completed in ${elapsed}s — ${firstResponseCount} first-response breach(es) flagged, ${escalatedCount} incident(s) escalated.`);
  } catch (err) {
    logger.error("Incident SLA sweep failed.", { error: err.message });
  }
}

class IncidentSlaScheduler {
  static _initialized = false;

  static async init() {
    if (this._initialized) return;
    this._initialized = true;

    try {
      cronLib = (await import("node-cron")).default;
    } catch (err) {
      logger.warn("node-cron not available — incident SLA sweeps disabled.", { error: err.message });
      return;
    }

    const expr = cronLib.validate(SLA_SWEEP_CRON) ? SLA_SWEEP_CRON : "*/10 * * * *";
    if (expr !== SLA_SWEEP_CRON) logger.error(`Invalid INCIDENT_SLA_SWEEP_CRON_SCHEDULE: "${SLA_SWEEP_CRON}". Falling back to "*/10 * * * *".`);

    slaJob = cronLib.schedule(expr, () => {
      withDistributedLock("scheduler:IncidentSlaScheduler", getSchedulerLockConfig().defaultLockTtlMs, runIncidentSlaSweep)
        .catch((err) => logger.error("Cron incident SLA sweep error", { error: err.message }));
    }, { scheduled: true, timezone: process.env.TZ || undefined });

    logger.info(`IncidentSlaScheduler started — schedule: "${expr}".`);
  }

  static stop() {
    if (slaJob) { slaJob.stop(); slaJob = null; }
    this._initialized = false;
    logger.info("IncidentSlaScheduler stopped.");
  }
}

export default IncidentSlaScheduler;
