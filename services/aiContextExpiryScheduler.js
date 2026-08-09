import mongoose from "mongoose";
import AIConversationModel from "../models/AIConversationModel.js";
import AIContextMemory from "./ai/AIContextMemory.js";
import { publishEvent } from "../utils/eventBus.js";
import logger from "../utils/logger.js";

const SWEEP_CRON = process.env.AI_MEMORY_EXPIRY_CRON_SCHEDULE || "*/15 * * * *";

let cronLib = null;
let expiryJob = null;

/**
 * EXT-027 §10/§11/§16 "Context Lifecycle ... Expired sessions automatically
 * removed ... Memory expires automatically." Clears (never deletes) the
 * structured `context` on conversations whose session memory has gone idle
 * past `AI_MEMORY_SESSION_TIMEOUT_MINUTES` — the message/tool-execution
 * transcript and the conversation document itself are untouched; only the
 * reusable Flight/Hotel/Passenger/Booking Context is reset, same effect as
 * AIAssistantService.clearContext() but system-triggered. Belt-and-suspenders
 * alongside AIAssistantService.chat()'s own lazy expiry check (a session
 * resumed via a new message before this sweep runs still starts fresh
 * rather than reusing stale memory) — this sweep is what clears sessions
 * the user never returns to at all.
 */
async function sweepExpiredContext() {
  const now = new Date();
  const conversations = await AIConversationModel.find({
    status: "active",
    "context.expiresAt": { $ne: null, $lte: now }
  }).select("_id tenantId");

  let count = 0;
  for (const conversation of conversations) {
    conversation.context = AIContextMemory.empty();
    await conversation.save();
    count += 1;
    publishEvent("AIContextExpired", { conversationId: conversation._id, tenantId: conversation.tenantId });
  }
  return count;
}

async function runContextExpirySweep() {
  if (mongoose.connection?.readyState !== 1) return;
  const startTime = Date.now();
  try {
    const count = await sweepExpiredContext();
    if (count > 0) {
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      logger.info(`AI context expiry sweep completed in ${elapsed}s — ${count} session(s) cleared.`);
    }
  } catch (err) {
    logger.error("AI context expiry sweep failed.", { error: err.message });
  }
}

class AIContextExpiryScheduler {
  static _initialized = false;

  static async init() {
    if (this._initialized) return;
    this._initialized = true;

    try {
      cronLib = (await import("node-cron")).default;
    } catch (err) {
      logger.warn("node-cron not available — AI context expiry sweeps disabled.", { error: err.message });
      return;
    }

    const expr = cronLib.validate(SWEEP_CRON) ? SWEEP_CRON : "*/15 * * * *";
    if (expr !== SWEEP_CRON) logger.error(`Invalid AI_MEMORY_EXPIRY_CRON_SCHEDULE: "${SWEEP_CRON}". Falling back to "*/15 * * * *".`);

    expiryJob = cronLib.schedule(expr, () => {
      runContextExpirySweep().catch((err) => logger.error("Cron AI context expiry sweep error", { error: err.message }));
    }, { scheduled: true, timezone: process.env.TZ || undefined });

    logger.info(`AIContextExpiryScheduler started — schedule: "${expr}".`);
  }

  static stop() {
    if (expiryJob) { expiryJob.stop(); expiryJob = null; }
    this._initialized = false;
    logger.info("AIContextExpiryScheduler stopped.");
  }
}

export default AIContextExpiryScheduler;
