import mongoose from "mongoose";
import AIConversationModel from "../models/AIConversationModel.js";
import AIAssistantService from "./AIAssistantService.js";
import { getAIConversationRetentionConfig } from "../utils/aiConfig.js";
import logger from "../utils/logger.js";

/**
 * Gap 1.2 "AI Conversation retention config is dead" — utils/aiConfig.js's
 * `conversationRetentionDays` ("Memory expires according to company
 * policy.") has always been read into getAIConfig() but never had a real
 * sweep consumer. This is that sweep: an `active` conversation with no
 * activity (no new message/save — `updatedAt`) inside the configured
 * retention window is left alone; one that's gone stale beyond it is
 * archived through AIAssistantService.archiveConversation() itself — same
 * method the manual "Archive" action uses — never a second, duplicated
 * archival code path. Mirrors aiApprovalTimeoutScheduler.js's own
 * init/stop/node-cron structure exactly.
 */
async function sweepStaleConversations() {
  const { retentionDays } = getAIConversationRetentionConfig();
  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);

  const stale = await AIConversationModel.find({ status: "active", updatedAt: { $lte: cutoff } }).select("_id tenantId userId").lean();
  let archivedCount = 0;
  for (const conv of stale) {
    await AIAssistantService.archiveConversation({ tenantId: conv.tenantId, userId: conv.userId, conversationId: conv._id });
    archivedCount += 1;
  }
  return { archivedCount };
}

async function runConversationRetentionSweep() {
  if (mongoose.connection?.readyState !== 1) return;
  const startTime = Date.now();
  try {
    const { archivedCount } = await sweepStaleConversations();
    if (archivedCount > 0) {
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      logger.info(`AI conversation retention sweep completed in ${elapsed}s — ${archivedCount} conversation(s) auto-archived.`);
    }
  } catch (err) {
    logger.error("AI conversation retention sweep failed.", { error: err.message });
  }
}

let cronLib = null;
let sweepJob = null;

class AIConversationRetentionScheduler {
  static _initialized = false;

  static async init() {
    if (this._initialized) return;
    this._initialized = true;

    try {
      cronLib = (await import("node-cron")).default;
    } catch (err) {
      logger.warn("node-cron not available — AI conversation retention sweeps disabled.", { error: err.message });
      return;
    }

    const { sweepCronSchedule } = getAIConversationRetentionConfig();
    const expr = cronLib.validate(sweepCronSchedule) ? sweepCronSchedule : "0 3 * * *";
    if (expr !== sweepCronSchedule) logger.error(`Invalid AI_CONVERSATION_RETENTION_CRON_SCHEDULE: "${sweepCronSchedule}". Falling back to "0 3 * * *".`);

    sweepJob = cronLib.schedule(expr, () => {
      runConversationRetentionSweep().catch((err) => logger.error("Cron AI conversation retention sweep error", { error: err.message }));
    }, { scheduled: true, timezone: process.env.TZ || undefined });

    logger.info(`AIConversationRetentionScheduler started — schedule: "${expr}".`);
  }

  static stop() {
    if (sweepJob) { sweepJob.stop(); sweepJob = null; }
    this._initialized = false;
    logger.info("AIConversationRetentionScheduler stopped.");
  }
}

export { sweepStaleConversations, runConversationRetentionSweep };
export default AIConversationRetentionScheduler;
