import test from "node:test";
import assert from "node:assert/strict";
import CommunicationPreferenceService from "../services/CommunicationPreferenceService.js";
import CommunicationPreferenceModel from "../models/CommunicationPreferenceModel.js";
import CommunicationConsentHistoryModel from "../models/CommunicationConsentHistoryModel.js";

const tenantId = "TENANT-TEST-PREF-001";
const userId = "USER-TEST-PREF-1";

test("CommunicationPreferenceService.updateUserPreferences — records a consent history entry with old/new values and actor", async () => {
  const origFindOne = CommunicationPreferenceModel.findOne;
  const origFindOneAndUpdate = CommunicationPreferenceModel.findOneAndUpdate;
  const origHistoryCreate = CommunicationConsentHistoryModel.create;

  const historyEntries = [];

  try {
    CommunicationPreferenceModel.findOne = () => ({
      lean: async () => ({ tenantId, userId, emailOptIn: true, smsOptIn: true, doNotDisturb: false })
    });
    CommunicationPreferenceModel.findOneAndUpdate = async (_query, update) => ({
      tenantId,
      userId,
      ...update.$set
    });
    CommunicationConsentHistoryModel.create = async (doc) => { historyEntries.push(doc); return doc; };

    await CommunicationPreferenceService.updateUserPreferences({
      tenantId,
      userId,
      preferences: { smsOptIn: false, doNotDisturb: true },
      actorUserId: "ADMIN-1"
    });

    assert.equal(historyEntries.length, 1);
    assert.equal(historyEntries[0].actorUserId, "ADMIN-1");

    const smsChange = historyEntries[0].changes.find((c) => c.field === "smsOptIn");
    assert.equal(smsChange.oldValue, true);
    assert.equal(smsChange.newValue, false);

    const dndChange = historyEntries[0].changes.find((c) => c.field === "doNotDisturb");
    assert.equal(dndChange.oldValue, false);
    assert.equal(dndChange.newValue, true);
  } finally {
    CommunicationPreferenceModel.findOne = origFindOne;
    CommunicationPreferenceModel.findOneAndUpdate = origFindOneAndUpdate;
    CommunicationConsentHistoryModel.create = origHistoryCreate;
  }
});

test("CommunicationPreferenceService.updateUserPreferences — no-op changes are not recorded as history", async () => {
  const origFindOne = CommunicationPreferenceModel.findOne;
  const origFindOneAndUpdate = CommunicationPreferenceModel.findOneAndUpdate;
  const origHistoryCreate = CommunicationConsentHistoryModel.create;

  const historyEntries = [];

  try {
    CommunicationPreferenceModel.findOne = () => ({
      lean: async () => ({ tenantId, userId, emailOptIn: true })
    });
    CommunicationPreferenceModel.findOneAndUpdate = async (_query, update) => ({
      tenantId,
      userId,
      ...update.$set
    });
    CommunicationConsentHistoryModel.create = async (doc) => { historyEntries.push(doc); return doc; };

    await CommunicationPreferenceService.updateUserPreferences({
      tenantId,
      userId,
      preferences: { emailOptIn: true }
    });

    assert.equal(historyEntries.length, 0);
  } finally {
    CommunicationPreferenceModel.findOne = origFindOne;
    CommunicationPreferenceModel.findOneAndUpdate = origFindOneAndUpdate;
    CommunicationConsentHistoryModel.create = origHistoryCreate;
  }
});

test("CommunicationPreferenceService.canSendToUser — blocks sends inside the user's quiet hours window", async () => {
  const origFindOne = CommunicationPreferenceModel.findOne;

  try {
    // Window that always contains "now" regardless of timezone/time-of-day the test runs at.
    CommunicationPreferenceModel.findOne = () => ({
      lean: async () => ({
        tenantId,
        userId,
        emailOptIn: true,
        doNotDisturb: false,
        quietHours: { start: "00:00", end: "23:59", timezone: "UTC" }
      })
    });

    const result = await CommunicationPreferenceService.canSendToUser({ tenantId, userId, channel: "Email" });
    assert.equal(result.allowed, false);
    assert.match(result.reason, /quiet hours/i);
  } finally {
    CommunicationPreferenceModel.findOne = origFindOne;
  }
});

test("CommunicationPreferenceService.canSendToUser — Critical priority bypasses quiet hours and DND", async () => {
  const origFindOne = CommunicationPreferenceModel.findOne;

  try {
    CommunicationPreferenceModel.findOne = () => ({
      lean: async () => ({
        tenantId,
        userId,
        emailOptIn: true,
        doNotDisturb: true,
        quietHours: { start: "00:00", end: "23:59", timezone: "UTC" }
      })
    });

    const result = await CommunicationPreferenceService.canSendToUser({
      tenantId,
      userId,
      channel: "Email",
      priority: "Critical"
    });
    assert.equal(result.allowed, true);
  } finally {
    CommunicationPreferenceModel.findOne = origFindOne;
  }
});

test("CommunicationPreferenceService.canSendToUser — blocks a topic the user has explicitly unsubscribed from", async () => {
  const origFindOne = CommunicationPreferenceModel.findOne;

  try {
    CommunicationPreferenceModel.findOne = () => ({
      lean: async () => ({
        tenantId,
        userId,
        emailOptIn: true,
        doNotDisturb: false,
        unsubscribedTopics: ["Marketing"]
      })
    });

    const blocked = await CommunicationPreferenceService.canSendToUser({
      tenantId,
      userId,
      channel: "Email",
      topic: "Marketing"
    });
    assert.equal(blocked.allowed, false);
    assert.match(blocked.reason, /Marketing/);

    const allowed = await CommunicationPreferenceService.canSendToUser({
      tenantId,
      userId,
      channel: "Email",
      topic: "Invoice"
    });
    assert.equal(allowed.allowed, true);
  } finally {
    CommunicationPreferenceModel.findOne = origFindOne;
  }
});
