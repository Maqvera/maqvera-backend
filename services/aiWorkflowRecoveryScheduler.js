import mongoose from "mongoose";
import AIOrchestrationService from "./AIOrchestrationService.js";
import { getAIWorkflowRecoveryConfig } from "../utils/aiConfig.js";
import logger from "../utils/logger.js";
import { withDistributedLock } from "../utils/distributedLock.js";
import { getSchedulerLockConfig } from "../utils/schedulerLockConfig.js";

let cronLib = null;
let recoveryJob = null;

/**
 * EXT-036 §22 "Recovery" — periodically sweeps for AI tool executions
 * abandoned mid-flight by a crashed/restarted process (status
 * "executing" with no new checkpoint save since AIOrchestrationService's
 * per-group checkpointing was added) and resumes them via
 * AIOrchestrationService.recoverStuckExecutions().
 */
async function runRecoverySweep() {
  if (mongoose.connection?.readyState !== 1) return;
  const startTime = Date.now();
  try {
    const result = await AIOrchestrationService.recoverStuckExecutions();
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    if (result.scanned > 0) {
      logger.info(`AI workflow recovery sweep completed in ${elapsed}s — ${result.scanned} stuck execution(s) found, ${result.recovered} resumed, ${result.failed} marked failed.`);
    }
  } catch (err) {
    logger.error("AI workflow recovery sweep failed.", { error: err.message });
  }
}

class AIWorkflowRecoveryScheduler {
  static _initialized = false;

  static async init() {
    if (this._initialized) return;
    this._initialized = true;

    try {
      cronLib = (await import("node-cron")).default;
    } catch (err) {
      logger.warn("node-cron not available — AI workflow recovery sweeps disabled.", { error: err.message });
      return;
    }

    const { sweepCronSchedule } = getAIWorkflowRecoveryConfig();
    const expr = cronLib.validate(sweepCronSchedule) ? sweepCronSchedule : "*/5 * * * *";
    if (expr !== sweepCronSchedule) logger.error(`Invalid AI_WORKFLOW_RECOVERY_CRON_SCHEDULE: "${sweepCronSchedule}". Falling back to "*/5 * * * *".`);

    recoveryJob = cronLib.schedule(expr, () => {
      withDistributedLock("scheduler:AIWorkflowRecoveryScheduler", getSchedulerLockConfig().defaultLockTtlMs, runRecoverySweep)
        .catch((err) => logger.error("Cron AI workflow recovery sweep error", { error: err.message }));
    }, { scheduled: true, timezone: process.env.TZ || undefined });

    logger.info(`AIWorkflowRecoveryScheduler started — schedule: "${expr}".`);
  }

  static stop() {
    if (recoveryJob) { recoveryJob.stop(); recoveryJob = null; }
    this._initialized = false;
    logger.info("AIWorkflowRecoveryScheduler stopped.");
  }
}

export default AIWorkflowRecoveryScheduler;
