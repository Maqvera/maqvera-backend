import CommunicationMessageModel from "../models/CommunicationMessageModel.js";
import CommunicationAuditModel from "../models/CommunicationAuditModel.js";
import CommunicationTemplateService from "./CommunicationTemplateService.js";
import CommunicationPreferenceService from "./CommunicationPreferenceService.js";
import { getDeliveryAdapter } from "./delivery/index.js";
import { publishEvent } from "../utils/eventBus.js";

/**
 * Enterprise Communication Platform Foundation Service — Part 1.
 * Centralized message routing, delivery tracking, provider adapter dispatch, retries,
 * preference filtering, audit logging, and domain event publishing across Email, SMS, WhatsApp, Push, InApp, and Webhooks.
 * Tenant-scoped only — no branchId per Master Architecture rules.
 */
class CommunicationPlatformService {
  static generateId(prefix = "MSG") {
    const timestamp = Date.now().toString(36).toUpperCase();
    const random = Math.random().toString(36).substring(2, 6).toUpperCase();
    return `${prefix}-${timestamp}-${random}`;
  }

  /**
   * Request message delivery from any business module (CRM, Booking, Travel, Visa, Finance, HR, Inventory, AI)
   */
  static async requestCommunication({
    tenantId,
    sourceModule = "System",
    channel = "Email",
    recipient = {},
    templateId = null,
    templateData = {},
    subject = null,
    content = null,
    priority = "Normal",
    scheduledAt = null,
    idempotencyKey = null,
    userId = null
  }) {
    if (!tenantId || !channel || !recipient) {
      throw new Error("Missing required communication fields (tenantId, channel, recipient).");
    }

    // 1. Idempotency Check
    if (idempotencyKey) {
      const existing = await CommunicationMessageModel.findOne({ tenantId, idempotencyKey }).lean();
      if (existing) return existing;
    }

    // 2. Preference & DND Enforcement
    const targetUserId = recipient.userId || userId;
    if (targetUserId) {
      const prefCheck = await CommunicationPreferenceService.canSendToUser({
        tenantId,
        userId: targetUserId,
        channel
      });
      if (!prefCheck.allowed) {
        // Record cancelled/blocked audit entry
        const blockedMsg = new CommunicationMessageModel({
          tenantId,
          messageId: this.generateId("MSG"),
          sourceModule,
          channel,
          recipient,
          subject,
          content,
          status: "Cancelled",
          priority,
          errorDetails: { message: prefCheck.reason },
          createdBy: userId
        });
        await blockedMsg.save();

        await this._logAudit({
          tenantId,
          messageId: blockedMsg.messageId,
          event: "CommunicationCancelled",
          channel,
          details: { reason: prefCheck.reason }
        });

        publishEvent("CommunicationCancelled", {
          tenantId,
          messageId: blockedMsg.messageId,
          channel,
          reason: prefCheck.reason
        });

        return blockedMsg;
      }
    }

    // 3. Template Resolution
    let finalSubject = subject;
    let finalContent = content;

    if (templateId) {
      const tpl = await CommunicationTemplateService.getTemplateById({ tenantId, templateId });
      finalSubject = CommunicationTemplateService.renderTemplate(tpl.subjectTemplate, templateData);
      finalContent = CommunicationTemplateService.renderTemplate(tpl.bodyTemplate, templateData);
    }

    const messageId = this.generateId("MSG");
    const isScheduled = scheduledAt && new Date(scheduledAt) > new Date();

    // 4. Create Communication Message Record
    const messageRecord = new CommunicationMessageModel({
      tenantId,
      messageId,
      sourceModule,
      channel,
      recipient,
      templateId,
      templateData,
      subject: finalSubject,
      content: finalContent,
      status: isScheduled ? "Queued" : "Processing",
      priority,
      scheduledAt: scheduledAt ? new Date(scheduledAt) : new Date(),
      idempotencyKey,
      createdBy: userId
    });

    await messageRecord.save();

    await this._logAudit({
      tenantId,
      messageId,
      event: isScheduled ? "CommunicationQueued" : "CommunicationRequested",
      channel,
      details: { sourceModule, recipient, isScheduled }
    });

    publishEvent(isScheduled ? "CommunicationQueued" : "CommunicationRequested", {
      tenantId,
      messageId,
      sourceModule,
      channel,
      recipient
    });

    if (isScheduled) {
      return messageRecord;
    }

    // 5. Dispatch Message through Provider Adapter Layer
    return await this._dispatchToProvider(messageRecord);
  }

  /**
   * Internal Provider Adapter Dispatcher
   */
  static async _dispatchToProvider(messageRecord) {
    const adapter = getDeliveryAdapter(messageRecord.channel);
    if (!adapter) {
      messageRecord.status = "Failed";
      messageRecord.errorDetails = { message: `No provider adapter registered for channel: ${messageRecord.channel}` };
      await messageRecord.save();

      await this._logAudit({
        tenantId: messageRecord.tenantId,
        messageId: messageRecord.messageId,
        event: "ProviderUnavailable",
        channel: messageRecord.channel,
        details: { error: messageRecord.errorDetails.message }
      });

      publishEvent("ProviderUnavailable", {
        tenantId: messageRecord.tenantId,
        messageId: messageRecord.messageId,
        channel: messageRecord.channel
      });

      return messageRecord;
    }

    try {
      const result = await adapter.send({
        to: messageRecord.recipient.email || messageRecord.recipient.phone || messageRecord.recipient.endpointUrl,
        subject: messageRecord.subject,
        body: messageRecord.content,
        recipient: messageRecord.recipient,
        templateData: messageRecord.templateData
      });

      if (result.status === "Sent") {
        messageRecord.status = "Delivered";
        messageRecord.deliveredAt = new Date();
        messageRecord.provider = adapter.channelName;
        messageRecord.providerResponse = result.providerResponse || {};
        await messageRecord.save();

        await this._logAudit({
          tenantId: messageRecord.tenantId,
          messageId: messageRecord.messageId,
          event: "CommunicationDelivered",
          channel: messageRecord.channel,
          provider: adapter.channelName,
          details: result
        });

        publishEvent("CommunicationDelivered", {
          tenantId: messageRecord.tenantId,
          messageId: messageRecord.messageId,
          channel: messageRecord.channel,
          provider: adapter.channelName
        });
      } else {
        messageRecord.status = "Failed";
        messageRecord.provider = adapter.channelName;
        messageRecord.errorDetails = { message: result.failureReason || "Delivery failed" };
        await messageRecord.save();

        await this._logAudit({
          tenantId: messageRecord.tenantId,
          messageId: messageRecord.messageId,
          event: "CommunicationFailed",
          channel: messageRecord.channel,
          provider: adapter.channelName,
          details: { reason: result.failureReason }
        });

        publishEvent("CommunicationFailed", {
          tenantId: messageRecord.tenantId,
          messageId: messageRecord.messageId,
          channel: messageRecord.channel,
          reason: result.failureReason
        });
      }
    } catch (err) {
      messageRecord.status = "Failed";
      messageRecord.errorDetails = { message: err.message };
      await messageRecord.save();

      await this._logAudit({
        tenantId: messageRecord.tenantId,
        messageId: messageRecord.messageId,
        event: "CommunicationFailed",
        channel: messageRecord.channel,
        details: { error: err.message }
      });

      publishEvent("CommunicationFailed", {
        tenantId: messageRecord.tenantId,
        messageId: messageRecord.messageId,
        channel: messageRecord.channel,
        reason: err.message
      });
    }

    return messageRecord;
  }

  /**
   * Retry failed message delivery
   */
  static async retryMessage({ tenantId, messageId, userId = null }) {
    if (!tenantId || !messageId) throw new Error("tenantId and messageId are required.");

    const message = await CommunicationMessageModel.findOne({ tenantId, messageId });
    if (!message) throw new Error(`Communication message ${messageId} not found.`);

    if (message.retryCount >= message.maxRetries) {
      throw new Error(`Maximum retry attempts (${message.maxRetries}) reached for message ${messageId}.`);
    }

    message.retryCount += 1;
    message.status = "Retried";
    await message.save();

    await this._logAudit({
      tenantId,
      messageId,
      event: "CommunicationRetried",
      channel: message.channel,
      details: { attempt: message.retryCount }
    });

    publishEvent("CommunicationRetried", {
      tenantId,
      messageId,
      channel: message.channel,
      attempt: message.retryCount
    });

    return await this._dispatchToProvider(message);
  }

  /**
   * Cancel queued or scheduled message
   */
  static async cancelMessage({ tenantId, messageId, reason = "User requested cancellation" }) {
    if (!tenantId || !messageId) throw new Error("tenantId and messageId are required.");

    const message = await CommunicationMessageModel.findOne({ tenantId, messageId });
    if (!message) throw new Error(`Communication message ${messageId} not found.`);

    message.status = "Cancelled";
    message.errorDetails = { message: reason };
    await message.save();

    await this._logAudit({
      tenantId,
      messageId,
      event: "CommunicationCancelled",
      channel: message.channel,
      details: { reason }
    });

    publishEvent("CommunicationCancelled", {
      tenantId,
      messageId,
      channel: message.channel,
      reason
    });

    return message;
  }

  /**
   * Fetch single message details
   */
  static async getMessageById({ tenantId, messageId }) {
    if (!tenantId || !messageId) throw new Error("tenantId and messageId are required.");
    const message = await CommunicationMessageModel.findOne({ tenantId, messageId }).lean();
    if (!message) throw new Error(`Communication message ${messageId} not found.`);
    return message;
  }

  /**
   * List communication messages with filters and pagination
   */
  static async listMessages({ tenantId, channel, status, sourceModule, page = 1, limit = 20 }) {
    if (!tenantId) throw new Error("tenantId is required.");
    const query = { tenantId };
    if (channel) query.channel = channel;
    if (status) query.status = status;
    if (sourceModule) query.sourceModule = sourceModule;

    const skip = (page - 1) * limit;
    const [data, total] = await Promise.all([
      CommunicationMessageModel.find(query).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      CommunicationMessageModel.countDocuments(query)
    ]);

    return { data, total, page: Number(page), limit: Number(limit) };
  }

  /**
   * Channel Analytics Summary
   */
  static async getCommunicationAnalytics({ tenantId }) {
    if (!tenantId) throw new Error("tenantId is required.");

    const [totalMessages, deliveredCount, failedCount, queuedCount, cancelledCount] = await Promise.all([
      CommunicationMessageModel.countDocuments({ tenantId }),
      CommunicationMessageModel.countDocuments({ tenantId, status: "Delivered" }),
      CommunicationMessageModel.countDocuments({ tenantId, status: "Failed" }),
      CommunicationMessageModel.countDocuments({ tenantId, status: "Queued" }),
      CommunicationMessageModel.countDocuments({ tenantId, status: "Cancelled" })
    ]);

    const deliveryRate = totalMessages > 0 ? Number(((deliveredCount / totalMessages) * 100).toFixed(2)) : 100.0;

    return {
      totalMessages,
      deliveredCount,
      failedCount,
      queuedCount,
      cancelledCount,
      deliveryRate,
      lastUpdated: new Date()
    };
  }

  /**
   * Internal helper for logging audit entries
   */
  static async _logAudit({ tenantId, messageId, event, channel, provider = null, details = {} }) {
    try {
      const audit = new CommunicationAuditModel({
        tenantId,
        auditId: this.generateId("AUD"),
        messageId,
        event,
        channel,
        provider,
        details
      });
      await audit.save();
    } catch (err) {
      console.error("Communication audit log failure:", err);
    }
  }
}

export default CommunicationPlatformService;
