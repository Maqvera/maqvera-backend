import test from "node:test";
import assert from "node:assert/strict";
import SmsPlatformService from "../services/SmsPlatformService.js";
import SmsCampaignModel from "../models/SmsCampaignModel.js";

const tenantId = "TENANT-TEST-SMSCAMPAIGN-001";
const campaignId = "CAMP-1";

function makeCampaign(recipients, overrides = {}) {
  const doc = {
    tenantId, campaignId, smsType: "Marketing", templateId: null, templateVariables: {}, messageText: "Hi!",
    recipients, status: "Processing", sentCount: 0, deliveredCount: 0, failedCount: 0,
    startedAt: null, lastProcessedAt: null, createdBy: "USER-1",
    ...overrides,
    save: async function () { return this; }
  };
  // Supports both direct use (`const campaign = await findOne(...)`) and the
  // mid-loop `.select("status").lean()` pause/cancel check — both resolve
  // against this SAME live object, so a status mutation is visible to both.
  doc.select = () => ({ lean: async () => ({ status: doc.status }) });
  return doc;
}

test("SmsPlatformService._processCampaignBatch — checkpoints progress every N recipients instead of only saving once at the end", async () => {
  const origFindOne = SmsCampaignModel.findOne;
  const origSendSms = SmsPlatformService.sendSms;

  const saveCalls = [];
  const recipients = Array.from({ length: 5 }, (_, i) => ({ phone: `+92300000000${i}`, status: "Pending", trackingId: null, failureReason: null }));
  const campaign = makeCampaign(recipients);
  campaign.save = async function () { saveCalls.push(this.sentCount); return this; };

  try {
    process.env.SMS_CAMPAIGN_CHECKPOINT_INTERVAL = "2";
    SmsCampaignModel.findOne = () => campaign;
    SmsPlatformService.sendSms = async ({ phone }) => ({ trackingId: `SMS-${phone}`, status: "Sent" });

    await SmsPlatformService._processCampaignBatch(tenantId, campaignId, "USER-1");

    // 5 recipients, checkpoint every 2 -> checkpoints at 2, 4, and a final
    // one at completion (5) = at least 3 saves total, not just one save
    // after the whole loop.
    assert.ok(saveCalls.length >= 3, `expected multiple checkpoint saves, got ${saveCalls.length}`);
    assert.equal(campaign.status, "Completed");
    assert.equal(campaign.sentCount, 5);
    assert.ok(recipients.every((r) => r.status === "Sent"));
  } finally {
    SmsCampaignModel.findOne = origFindOne;
    SmsPlatformService.sendSms = origSendSms;
    delete process.env.SMS_CAMPAIGN_CHECKPOINT_INTERVAL;
  }
});

test("SmsPlatformService._processCampaignBatch — resuming a partially-completed campaign adds to prior counts instead of overwriting them, and skips already-sent recipients", async () => {
  const origFindOne = SmsCampaignModel.findOne;
  const origSendSms = SmsPlatformService.sendSms;

  // Simulates a crash after the first recipient was already sent (and
  // checkpointed) — recipient 0 is "Sent" with sentCount already at 1;
  // recipient 1 is still "Pending".
  const recipients = [
    { phone: "+923000000000", status: "Sent", trackingId: "SMS-OLD-1", failureReason: null },
    { phone: "+923000000001", status: "Pending", trackingId: null, failureReason: null }
  ];
  const campaign = makeCampaign(recipients, { sentCount: 1, deliveredCount: 0, failedCount: 0 });

  let sendCallCount = 0;

  try {
    SmsCampaignModel.findOne = () => campaign;
    SmsPlatformService.sendSms = async ({ phone }) => { sendCallCount += 1; return { trackingId: `SMS-NEW-${phone}`, status: "Sent" }; };

    await SmsPlatformService._processCampaignBatch(tenantId, campaignId, "USER-1");

    // Only the still-Pending recipient was actually sent to.
    assert.equal(sendCallCount, 1);
    // Cumulative: 1 (already there) + 1 (this run) = 2, not just 1.
    assert.equal(campaign.sentCount, 2);
    assert.equal(recipients[0].trackingId, "SMS-OLD-1", "the already-sent recipient must not be re-sent or overwritten");
    assert.equal(recipients[1].status, "Sent");
  } finally {
    SmsCampaignModel.findOne = origFindOne;
    SmsPlatformService.sendSms = origSendSms;
  }
});

test("SmsPlatformService.recoverStuckCampaigns — finds campaigns stuck in Processing with a stale heartbeat and resumes them", async () => {
  const origFind = SmsCampaignModel.find;
  const origProcess = SmsPlatformService._processCampaignBatch;

  const resumedCampaignIds = [];

  try {
    SmsCampaignModel.find = () => ({ select: () => ({ lean: async () => [
      { tenantId, campaignId: "CAMP-STUCK-1", createdBy: "USER-1" },
      { tenantId, campaignId: "CAMP-STUCK-2", createdBy: "USER-2" }
    ] }) });
    SmsPlatformService._processCampaignBatch = async (t, cid) => { resumedCampaignIds.push(cid); };

    const result = await SmsPlatformService.recoverStuckCampaigns({ staleAfterMs: 60000 });

    assert.equal(result.scanned, 2);
    assert.equal(result.recovered, 2);
    assert.deepEqual(resumedCampaignIds, ["CAMP-STUCK-1", "CAMP-STUCK-2"]);
  } finally {
    SmsCampaignModel.find = origFind;
    SmsPlatformService._processCampaignBatch = origProcess;
  }
});

test("SmsPlatformService.updateCampaignStatus — resume only starts processing after the status change is durably saved (no race on the pre-save status)", async () => {
  const origFindOne = SmsCampaignModel.findOne;
  const origProcess = SmsPlatformService._processCampaignBatch;

  const events = [];

  try {
    const campaign = {
      tenantId, campaignId, status: "Paused", createdBy: "USER-1",
      save: async function () { events.push("saved:" + this.status); return this; }
    };
    SmsCampaignModel.findOne = async () => campaign;
    SmsPlatformService._processCampaignBatch = async () => { events.push("processing-started"); };

    await SmsPlatformService.updateCampaignStatus({ tenantId, campaignId, action: "resume" });

    assert.deepEqual(events, ["saved:Processing", "processing-started"], "save() must complete before _processCampaignBatch starts");
  } finally {
    SmsCampaignModel.findOne = origFindOne;
    SmsPlatformService._processCampaignBatch = origProcess;
  }
});
