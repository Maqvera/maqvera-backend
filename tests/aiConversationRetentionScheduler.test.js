import test, { after } from "node:test";
import assert from "node:assert/strict";
import dotenv from "dotenv";
import mongoose from "mongoose";
import { sweepStaleConversations } from "../services/aiConversationRetentionScheduler.js";
import { getAIConversationRetentionConfig } from "../utils/aiConfig.js";

dotenv.config();

// Gap 1.2 "AI Conversation retention config is dead" — proves
// conversationRetentionDays now has a real sweep consumer: a conversation
// older than the configured window gets archived through
// AIAssistantService.archiveConversation() itself (never a duplicated
// archival code path), one within the window is left untouched. Same
// dbAvailable-gated convention as tests/packagePricingController.test.js.

let dbAvailable = false;
const uri = process.env.URI || process.env.MONGO_URI;
if (uri) {
  try {
    await mongoose.connect(uri, { serverSelectionTimeoutMS: 8000 });
    dbAvailable = mongoose.connection.readyState === 1;
  } catch {
    dbAvailable = false;
  }
}

const dbSkipReason = "No reachable MongoDB configured (set URI in .env) — skipping live integration test.";

test("getAIConversationRetentionConfig reuses getAIConfig().conversationRetentionDays as its single source of truth", () => {
  const config = getAIConversationRetentionConfig();
  assert.equal(typeof config.retentionDays, "number");
  assert.ok(config.retentionDays > 0);
  assert.ok(config.sweepCronSchedule);
});

test("sweepStaleConversations archives an active conversation past the retention window and leaves a recent one alone", { skip: !dbAvailable && dbSkipReason }, async (t) => {
  const AIConversationModel = (await import("../models/AIConversationModel.js")).default;
  const { sweepStaleConversations: sweep } = await import("../services/aiConversationRetentionScheduler.js");
  const { retentionDays } = getAIConversationRetentionConfig();

  const suffix = Date.now();
  const tenantId = `test-ai-retention-${suffix}`;
  const userId = "tester";

  t.after(async () => { await AIConversationModel.deleteMany({ tenantId }); });

  const staleConv = await AIConversationModel.create({ tenantId, userId, status: "active", messages: [{ role: "user", content: "hello" }] });
  const freshConv = await AIConversationModel.create({ tenantId, userId, status: "active", messages: [{ role: "user", content: "hi" }] });
  const alreadyArchivedConv = await AIConversationModel.create({ tenantId, userId, status: "archived", archivedAt: new Date() });

  const staleDate = new Date(Date.now() - (retentionDays + 1) * 24 * 60 * 60 * 1000);
  await AIConversationModel.collection.updateOne({ _id: staleConv._id }, { $set: { updatedAt: staleDate } });
  const alreadyArchivedStaleDate = new Date(Date.now() - (retentionDays + 5) * 24 * 60 * 60 * 1000);
  await AIConversationModel.collection.updateOne({ _id: alreadyArchivedConv._id }, { $set: { updatedAt: alreadyArchivedStaleDate } });

  const { archivedCount } = await sweep();
  assert.ok(archivedCount >= 1, "expected at least the deliberately-stale conversation to be archived");

  const staleAfter = await AIConversationModel.findById(staleConv._id).lean();
  assert.equal(staleAfter.status, "archived", "a conversation past the retention window with no recent activity must be archived");
  assert.ok(staleAfter.archivedAt);

  const freshAfter = await AIConversationModel.findById(freshConv._id).lean();
  assert.equal(freshAfter.status, "active", "a conversation within the retention window must NOT be archived");

  const alreadyArchivedAfter = await AIConversationModel.findById(alreadyArchivedConv._id).lean();
  assert.equal(alreadyArchivedAfter.status, "archived", "an already-archived conversation must be left alone, not re-processed");
});

after(async () => {
  if (dbAvailable) await mongoose.disconnect();
});
