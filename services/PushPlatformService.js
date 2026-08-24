import CommunicationMessageModel from "../models/CommunicationMessageModel.js";
import CommunicationAuditModel from "../models/CommunicationAuditModel.js";
import DeviceTokenModel from "../models/DeviceTokenModel.js";
import CommunicationPreferenceService from "./CommunicationPreferenceService.js";
import { getDeliveryAdapter } from "./delivery/index.js";
import { publishEvent } from "../utils/eventBus.js";
import { dispatchCommunicationWithResilience } from "../utils/communicationResilience.js";

// The same Push ProviderRouter (Part 13) the generic Communication Platform
// dispatch path uses — a second real provider (raw APNs) later is a config
// change to services/delivery/index.js, not new plumbing here.
const pushChannelRouter = getDeliveryAdapter("Push");

/**
 * Enterprise Push Notification Platform Service — Part 5.
 * Device registry (register/unregister real FCM/APNs/web-push tokens) +
 * resilient dispatch, mirroring WhatsAppPlatformService.js's / Sms
 * PlatformService.js's structure. The push payload stays business-logic-free
 * — `{ screen, params }` only (see BaseDeliveryAdapter/FcmDeliveryAdapter's
 * own doc comments) — this service and its adapter never know what a
 * "screen" name means to any calling module.
 * Tenant-scoped only — no branchId per Master Architecture rules.
 */
class PushPlatformService {
  static generateId(prefix = "PUSH") {
    const timestamp = Date.now().toString(36).toUpperCase();
    const random = Math.random().toString(36).substring(2, 6).toUpperCase();
    return `${prefix}-${timestamp}-${random}`;
  }

  // ── Device Registry ─────────────────────────────────────────

  static async registerDevice({ tenantId, userId, platform, token, topics = [] }) {
    if (!tenantId || !userId) throw new Error("tenantId and userId are required.");
    if (!platform || !["ios", "android", "web"].includes(platform)) throw new Error("platform must be one of: ios, android, web.");
    if (!token) throw new Error("token is required.");

    const device = await DeviceTokenModel.findOneAndUpdate(
      { tenantId, token },
      { $set: { tenantId, userId: String(userId), platform, token, topics, lastSeenAt: new Date() } },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    publishEvent("DeviceRegistered", { tenantId, userId: String(userId), platform, deviceId: device._id.toString() });
    return device.toJSON();
  }

  static async unregisterDevice({ tenantId, token }) {
    if (!tenantId || !token) throw new Error("tenantId and token are required.");
    const result = await DeviceTokenModel.deleteOne({ tenantId, token });
    if (result.deletedCount > 0) publishEvent("DeviceUnregistered", { tenantId, token });
    return { removed: result.deletedCount > 0 };
  }

  static async listDevices({ tenantId, userId }) {
    if (!tenantId || !userId) throw new Error("tenantId and userId are required.");
    return DeviceTokenModel.find({ tenantId, userId: String(userId) }).sort({ lastSeenAt: -1 }).lean();
  }

  // ── Send ─────────────────────────────────────────────────────

  /**
   * Sends to every device currently registered for `userId` (a user may have
   * several — phone, tablet, browser). A dead token FCM reports as
   * no-longer-registered is pruned from the registry, not retried forever.
   */
  static async sendPush({
    tenantId,
    userId,
    subject = null,
    content = null,
    screen = null,
    params = {},
    sourceModule = "System",
    priority = "Normal",
    idempotencyKey = null
  }) {
    if (!tenantId) throw new Error("tenantId is required.");
    if (!userId) throw new Error("userId is required.");
    if (!subject && !content) throw new Error("subject or content must be provided.");

    const prefCheck = await CommunicationPreferenceService.canSendToUser({ tenantId, userId, channel: "Push", priority });
    if (!prefCheck.allowed) {
      throw new Error(`Push delivery blocked by user preference or DND: ${prefCheck.reason}`);
    }

    const devices = await this.listDevices({ tenantId, userId });
    if (devices.length === 0) {
      throw new Error(`No registered device found for user ${userId}.`);
    }

    if (idempotencyKey) {
      const existing = await CommunicationMessageModel.findOne({ tenantId, idempotencyKey }).lean();
      if (existing) return [{ trackingId: existing.trackingId || existing.messageId, messageId: existing.messageId, status: existing.status, queuedAt: existing.createdAt }];
    }

    const results = await Promise.all(devices.map((device) => this._sendToDevice({ tenantId, userId, device, subject, content, screen, params, sourceModule, priority, idempotencyKey: devices.length === 1 ? idempotencyKey : null })));
    return results;
  }

  static async _sendToDevice({ tenantId, userId, device, subject, content, screen, params, sourceModule, priority, idempotencyKey }) {
    const trackingId = this.generateId("PUSH");
    const messageId = trackingId;

    const pushRecord = new CommunicationMessageModel({
      tenantId,
      messageId,
      trackingId,
      sourceModule,
      channel: "Push",
      recipient: { pushToken: device.token, userId: String(userId) },
      subject,
      content,
      deepLink: { screen, params },
      status: "Processing",
      priority,
      idempotencyKey,
      createdBy: userId
    });
    await pushRecord.save();

    publishEvent("PushRequested", { tenantId, trackingId, userId, platform: device.platform });
    await this._logAudit({ tenantId, messageId: trackingId, event: "CommunicationRequested", details: { userId, platform: device.platform } });

    try {
      const result = await dispatchCommunicationWithResilience({
        channel: "Push",
        tenantId,
        messageId: trackingId,
        sourceModule,
        idempotencyKey,
        recipient: pushRecord.recipient,
        run: async () => {
          const sendResult = await pushChannelRouter.send({ tenantId, messageId: trackingId, to: device.token, subject, body: content, deepLink: { screen, params } });
          if (sendResult.status !== "Sent") {
            if (sendResult.invalidToken) {
              await DeviceTokenModel.deleteOne({ tenantId, token: device.token }).catch(() => {});
              publishEvent("DeviceUnregistered", { tenantId, token: device.token, reason: "InvalidToken" });
            }
            throw new Error(sendResult.failureReason || "Push delivery failed.");
          }
          return sendResult;
        }
      });

      pushRecord.status = "Delivered";
      pushRecord.deliveredAt = new Date();
      pushRecord.provider = result.provider || "FCM";
      pushRecord.providerResponse = result.providerResponse || {};
      await pushRecord.save();

      publishEvent("PushDelivered", { tenantId, trackingId, provider: pushRecord.provider });
      await this._logAudit({ tenantId, messageId: trackingId, event: "CommunicationDelivered", provider: pushRecord.provider, details: result });
    } catch (dispatchErr) {
      pushRecord.status = "Failed";
      pushRecord.errorDetails = { message: dispatchErr.message };
      pushRecord.dlqId = dispatchErr.dlqId || null;
      await pushRecord.save();

      publishEvent("PushFailed", { tenantId, trackingId, reason: dispatchErr.message, dlqId: dispatchErr.dlqId || null });
      await this._logAudit({ tenantId, messageId: trackingId, event: "CommunicationFailed", details: { reason: dispatchErr.message, dlqId: dispatchErr.dlqId || null } });
    }

    return {
      trackingId,
      messageId: trackingId,
      deviceToken: device.token,
      platform: device.platform,
      status: pushRecord.status,
      provider: pushRecord.provider,
      failureReason: pushRecord.errorDetails?.message || null,
      queuedAt: pushRecord.createdAt
    };
  }

  static async getPushTrackingStatus({ tenantId, trackingId }) {
    if (!tenantId || !trackingId) throw new Error("tenantId and trackingId are required.");
    const push = await CommunicationMessageModel.findOne({ tenantId, $or: [{ trackingId }, { messageId: trackingId }], channel: "Push" }).lean();
    if (!push) throw new Error(`Push tracking record not found for ID: ${trackingId}`);
    return {
      trackingId: push.trackingId || push.messageId,
      status: push.status,
      provider: push.provider,
      deliveredAt: push.deliveredAt,
      failureReason: push.errorDetails?.message || null,
      dlqId: push.dlqId || null,
      createdAt: push.createdAt
    };
  }

  static async _logAudit({ tenantId, messageId, event, provider = null, details = {} }) {
    try {
      const audit = new CommunicationAuditModel({ tenantId, auditId: this.generateId("AUD"), messageId, event, channel: "Push", provider, details });
      await audit.save();
      publishEvent("CommunicationAuditCreated", { tenantId, auditId: audit.auditId });
    } catch (err) {
      console.error("Push audit log failure:", err);
    }
  }
}

export default PushPlatformService;
