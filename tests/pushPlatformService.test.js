import test from "node:test";
import assert from "node:assert/strict";
import PushPlatformService from "../services/PushPlatformService.js";
import DeviceTokenModel from "../models/DeviceTokenModel.js";
import CommunicationMessageModel from "../models/CommunicationMessageModel.js";
import CommunicationAuditModel from "../models/CommunicationAuditModel.js";
import CommunicationPreferenceService from "../services/CommunicationPreferenceService.js";
import FcmDeliveryAdapter from "../services/delivery/FcmDeliveryAdapter.js";
import DeadLetterQueueModel from "../models/DeadLetterQueueModel.js";
import AuditLogModel from "../models/AuditLogmodel.js";

const tenantId = "TENANT-TEST-PUSH-001";
const userId = "USER-TEST-PUSH-1";

test("PushPlatformService.registerDevice — validates platform and upserts by (tenantId, token)", async () => {
  await assert.rejects(
    async () => PushPlatformService.registerDevice({ tenantId, userId, platform: "windows-phone", token: "T1" }),
    /platform must be one of/
  );

  const origUpsert = DeviceTokenModel.findOneAndUpdate;
  let capturedQuery = null;
  try {
    DeviceTokenModel.findOneAndUpdate = (query, update) => {
      capturedQuery = query;
      return { _id: "DEV-1", toJSON: () => ({ _id: "DEV-1", ...update.$set }) };
    };
    const device = await PushPlatformService.registerDevice({ tenantId, userId, platform: "android", token: "TOKEN-123" });
    assert.deepEqual(capturedQuery, { tenantId, token: "TOKEN-123" });
    assert.equal(device.platform, "android");
  } finally {
    DeviceTokenModel.findOneAndUpdate = origUpsert;
  }
});

test("PushPlatformService.sendPush — throws when the user has no registered device (never silently no-ops)", async () => {
  const origPref = CommunicationPreferenceService.canSendToUser;
  const origFind = DeviceTokenModel.find;
  try {
    CommunicationPreferenceService.canSendToUser = async () => ({ allowed: true });
    DeviceTokenModel.find = () => ({ sort: () => ({ lean: async () => [] }) });

    await assert.rejects(
      async () => PushPlatformService.sendPush({ tenantId, userId, subject: "Hi" }),
      /No registered device found/
    );
  } finally {
    CommunicationPreferenceService.canSendToUser = origPref;
    DeviceTokenModel.find = origFind;
  }
});

test("PushPlatformService.sendPush — dispatches to every registered device and carries the deep-link { screen, params } contract, not business logic", async () => {
  const origPref = CommunicationPreferenceService.canSendToUser;
  const origFind = DeviceTokenModel.find;
  const origSave = CommunicationMessageModel.prototype.save;
  const origMsgFindOne = CommunicationMessageModel.findOne;
  const origAuditSave = CommunicationAuditModel.prototype.save;
  const origFcmSend = FcmDeliveryAdapter.prototype.send;

  const sentPayloads = [];

  try {
    CommunicationPreferenceService.canSendToUser = async () => ({ allowed: true });
    DeviceTokenModel.find = () => ({ sort: () => ({ lean: async () => [
      { token: "TOKEN-A", platform: "android" },
      { token: "TOKEN-B", platform: "ios" }
    ] }) });
    CommunicationMessageModel.prototype.save = async function () { return this; };
    CommunicationMessageModel.findOne = async () => null;
    CommunicationAuditModel.prototype.save = async function () { return this; };
    FcmDeliveryAdapter.prototype.send = async function (params) {
      sentPayloads.push(params);
      return { status: "Sent", providerResponse: { messageId: "FCM-1" }, failureReason: null };
    };

    const results = await PushPlatformService.sendPush({
      tenantId, userId, subject: "Visa approved", content: "Tap to view", screen: "VisaCaseDetail", params: { caseId: "VC-1" }
    });

    assert.equal(results.length, 2);
    assert.ok(results.every((r) => r.status === "Delivered"));
    assert.equal(sentPayloads.length, 2);
    assert.equal(sentPayloads[0].deepLink.screen, "VisaCaseDetail");
    assert.deepEqual(sentPayloads[0].deepLink.params, { caseId: "VC-1" });
    // The adapter/service must never see "VisaCase" as a concept beyond this
    // opaque screen/params pair — no visa-specific field anywhere in the call.
    assert.deepEqual(Object.keys(sentPayloads[0].deepLink).sort(), ["params", "screen"]);
  } finally {
    CommunicationPreferenceService.canSendToUser = origPref;
    DeviceTokenModel.find = origFind;
    CommunicationMessageModel.prototype.save = origSave;
    CommunicationMessageModel.findOne = origMsgFindOne;
    CommunicationAuditModel.prototype.save = origAuditSave;
    FcmDeliveryAdapter.prototype.send = origFcmSend;
  }
});

test("PushPlatformService.sendPush — a dead token (FCM 'not registered') is pruned from the device registry, not retried forever", async () => {
  const origPref = CommunicationPreferenceService.canSendToUser;
  const origFind = DeviceTokenModel.find;
  const origDelete = DeviceTokenModel.deleteOne;
  const origSave = CommunicationMessageModel.prototype.save;
  const origMsgFindOne = CommunicationMessageModel.findOne;
  const origAuditSave = CommunicationAuditModel.prototype.save;
  const origFcmSend = FcmDeliveryAdapter.prototype.send;
  const origDlqCreate = DeadLetterQueueModel.create;
  const origAuditLogCreate = AuditLogModel.create;

  let deletedToken = null;

  try {
    CommunicationPreferenceService.canSendToUser = async () => ({ allowed: true });
    DeviceTokenModel.find = () => ({ sort: () => ({ lean: async () => [{ token: "TOKEN-DEAD", platform: "android" }] }) });
    DeviceTokenModel.deleteOne = async (query) => { deletedToken = query.token; return { deletedCount: 1 }; };
    CommunicationMessageModel.prototype.save = async function () { return this; };
    CommunicationMessageModel.findOne = async () => null;
    CommunicationAuditModel.prototype.save = async function () { return this; };
    DeadLetterQueueModel.create = async (doc) => ({ ...doc, _id: "DLQ-PUSH-1" });
    AuditLogModel.create = async (doc) => doc;
    FcmDeliveryAdapter.prototype.send = async function () {
      return { status: "Failed", providerResponse: null, failureReason: "messaging/registration-token-not-registered", invalidToken: true };
    };

    const results = await PushPlatformService.sendPush({ tenantId, userId, subject: "Hi" });

    assert.equal(results[0].status, "Failed");
    assert.equal(deletedToken, "TOKEN-DEAD");
  } finally {
    CommunicationPreferenceService.canSendToUser = origPref;
    DeviceTokenModel.find = origFind;
    DeviceTokenModel.deleteOne = origDelete;
    CommunicationMessageModel.prototype.save = origSave;
    CommunicationMessageModel.findOne = origMsgFindOne;
    CommunicationAuditModel.prototype.save = origAuditSave;
    FcmDeliveryAdapter.prototype.send = origFcmSend;
    DeadLetterQueueModel.create = origDlqCreate;
    AuditLogModel.create = origAuditLogCreate;
  }
});
