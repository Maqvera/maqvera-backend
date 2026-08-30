import mongoose from "mongoose";
import AIRequestMetricModel from "../models/AIRequestMetricModel.js";
import AIObservabilityService from "./ai/AIObservabilityService.js";
import AIAssistantService from "./AIAssistantService.js";
import AIOrchestrationService from "./AIOrchestrationService.js";
import { getAIObservabilityConfig } from "../utils/aiObservabilityConfig.js";
import logger from "../utils/logger.js";
import { withDistributedLock } from "../utils/distributedLock.js";
import { getSchedulerLockConfig } from "../utils/schedulerLockConfig.js";

/**
 * EXT-033 §19 "Alerting." Real threshold evaluation on a cron sweep — the
 * background counterpart to AIObservabilityController's on-demand
 * `POST /alerts/evaluate`. Discovers which tenants to evaluate dynamically
 * from real recent activity (`AIRequestMetricModel.distinct`) rather than
 * a hardcoded tenant list, same "no hardcoding" discipline as every other
 * scheduler in this codebase.
 */
async function runObservabilityAlertSweep() {
  if (mongoose.connection?.readyState !== 1) return;
  const startTime = Date.now();
  try {
    const config = getAIObservabilityConfig();
    const since = new Date(Date.now() - config.alertEvaluationWindowMs);
    const activeTenantIds = await AIRequestMetricModel.distinct("tenantId", { createdAt: { $gte: since } });
    if (activeTenantIds.length === 0) return;

    const [chatStatus, orchestrationStatus] = await Promise.all([AIAssistantService.getProviderStatus(), AIOrchestrationService.getProviderStatus()]);
    const providerStatus = { ...chatStatus, ...orchestrationStatus };

    let triggeredCount = 0;
    let resolvedCount = 0;
    for (const tenantId of activeTenantIds) {
      const result = await AIObservabilityService.evaluateAlerts({ tenantId, providerStatus });
      triggeredCount += result.triggered.length;
      resolvedCount += result.resolved.length;
    }

    if (triggeredCount > 0 || resolvedCount > 0) {
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      logger.info(`AI observability alert sweep completed in ${elapsed}s — ${activeTenantIds.length} tenant(s) evaluated, ${triggeredCount} alert(s) triggered, ${resolvedCount} resolved.`);
    }
  } catch (err) {
    logger.error("AI observability alert sweep failed.", { error: err.message });
  }
}

let cronLib = null;
let sweepJob = null;

class AIObservabilityAlertScheduler {
  static _initialized = false;

  static async init() {
    if (this._initialized) return;
    this._initialized = true;

    try {
      cronLib = (await import("node-cron")).default;
    } catch (err) {
      logger.warn("node-cron not available — AI observability alert sweeps disabled.", { error: err.message });
      return;
    }

    const { sweepCronSchedule } = getAIObservabilityConfig();
    const expr = cronLib.validate(sweepCronSchedule) ? sweepCronSchedule : "*/10 * * * *";
    if (expr !== sweepCronSchedule) logger.error(`Invalid AI_OBSERVABILITY_ALERT_CRON_SCHEDULE: "${sweepCronSchedule}". Falling back to "*/10 * * * *".`);

    sweepJob = cronLib.schedule(expr, () => {
      withDistributedLock("scheduler:AIObservabilityAlertScheduler", getSchedulerLockConfig().defaultLockTtlMs, runObservabilityAlertSweep)
        .catch((err) => logger.error("Cron AI observability alert sweep error", { error: err.message }));
    }, { scheduled: true, timezone: process.env.TZ || undefined });

    logger.info(`AIObservabilityAlertScheduler started — schedule: "${expr}".`);
  }

  static stop() {
    if (sweepJob) { sweepJob.stop(); sweepJob = null; }
    this._initialized = false;
    logger.info("AIObservabilityAlertScheduler stopped.");
  }
}

export default AIObservabilityAlertScheduler;
