import CommunicationMessageModel from "../models/CommunicationMessageModel.js";
import CommunicationAuditModel from "../models/CommunicationAuditModel.js";
import CommunicationTemplateService from "./CommunicationTemplateService.js";
import CommunicationPreferenceService from "./CommunicationPreferenceService.js";
import { getDeliveryAdapter } from "./delivery/index.js";
import { publishEvent } from "../utils/eventBus.js";
import { dispatchCommunicationWithResilience } from "../utils/communicationResilience.js";
import WhatsAppConversationService from "./WhatsAppConversationService.js";
import CommunicationAnalyticsEngine from "./CommunicationAnalyticsEngine.js";
import { archiveRecord, restoreRecord, purgeRecord } from "../utils/archivalService.js";
import { applyLegalHold, removeLegalHold, getLegalHoldStatus } from "../utils/legalHold.js";
import TenantSubscriptionService from "./TenantSubscriptionService.js";
import { getFinanceConfig } from "../utils/financeConfig.js";
import logger from "../utils/logger.js";

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
    locale = "en",
    subject = null,
    content = null,
    priority = "Normal",
    scheduledAt = null,
    idempotencyKey = null,
    topic = null,
    deepLink = null,
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
        channel,
        priority,
        topic
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

    // 3. WhatsApp Conversation-Window Compliance Gate (Part 4) — a free-form
    // (non-templated) WhatsApp send outside Meta's 24-hour customer
    // conversation window is a WhatsApp Business policy violation. Enforced
    // HERE, at the shared foundation entry point, so no caller of this
    // generic API can bypass it — not just WhatsAppPlatformService's own
    // dedicated entry point.
    if (channel === "WhatsApp" && !templateId && recipient.phone) {
      const windowOpen = await WhatsAppConversationService.isWindowOpen({ tenantId, phone: recipient.phone });
      if (!windowOpen) {
        const reason = `An approved WhatsApp template is required to message ${recipient.phone}: no open 24-hour customer conversation window (Meta's WhatsApp Business policy prohibits free-form business-initiated messages outside this window).`;
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
          errorDetails: { message: reason },
          createdBy: userId
        });
        await blockedMsg.save();

        await this._logAudit({
          tenantId,
          messageId: blockedMsg.messageId,
          event: "CommunicationCancelled",
          channel,
          details: { reason }
        });

        publishEvent("CommunicationCancelled", {
          tenantId,
          messageId: blockedMsg.messageId,
          channel,
          reason
        });

        return blockedMsg;
      }
    }

    // 4. Template Resolution
    let finalSubject = subject;
    let finalContent = content;

    if (templateId) {
      // Part 8 fix — the real approval gate: only an "Active" (approved)
      // template can ever be resolved for an actual send, regardless of
      // which module supplies the templateId.
      const tpl = await CommunicationTemplateService.getPublishedTemplateForSend({ tenantId, templateId, locale });
      finalSubject = CommunicationTemplateService.renderTemplate(tpl.subjectTemplate, templateData);
      finalContent = CommunicationTemplateService.renderTemplate(tpl.bodyTemplate, templateData);
    }

    const messageId = this.generateId("MSG");
    const isScheduled = scheduledAt && new Date(scheduledAt) > new Date();

    // 5. Create Communication Message Record
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
      deepLink: deepLink || undefined,
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

    // 6. Dispatch Message through Provider Adapter Layer
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
      // Retry-with-backoff + circuit breaker + Dead Letter Queue hand-off on
      // exhaustion/permanent failure — the shared resilience engine every
      // other integration in this codebase uses (Part 11 fix), not a
      // one-shot adapter call with manual-retry-only recovery.
      const result = await dispatchCommunicationWithResilience({
        channel: messageRecord.channel,
        tenantId: messageRecord.tenantId,
        messageId: messageRecord.messageId,
        sourceModule: messageRecord.sourceModule,
        idempotencyKey: messageRecord.idempotencyKey,
        recipient: messageRecord.recipient,
        run: async () => {
          const sendResult = await adapter.send({
            tenantId: messageRecord.tenantId,
            messageId: messageRecord.messageId,
            to: messageRecord.recipient.email || messageRecord.recipient.phone || messageRecord.recipient.pushToken || messageRecord.recipient.endpointUrl,
            subject: messageRecord.subject,
            body: messageRecord.content,
            recipient: messageRecord.recipient,
            templateData: messageRecord.templateData,
            // Push Notification Platform (Part 5) — "{ screen, params }, not
            // business logic." Harmless extra field for every other channel's
            // adapter, which simply ignores it.
            deepLink: messageRecord.deepLink || {}
          });
          if (sendResult.status !== "Sent") {
            throw new Error(sendResult.failureReason || `${messageRecord.channel} delivery failed.`);
          }
          return sendResult;
        }
      });

      messageRecord.status = "Delivered";
      messageRecord.deliveredAt = new Date();
      // `result.provider` is the specific provider that actually handled it
      // (e.g. "Twilio" vs "Vonage") when the adapter is a ProviderRouter;
      // adapter.channelName is the honest fallback for the one channel
      // (Webhook) that's still a raw single adapter.
      messageRecord.provider = result.provider || adapter.channelName;
      messageRecord.providerResponse = result.providerResponse || {};
      await messageRecord.save();

      if (messageRecord.channel === "WhatsApp" && messageRecord.recipient?.phone) {
        await WhatsAppConversationService.recordOutboundMessage({ tenantId: messageRecord.tenantId, phone: messageRecord.recipient.phone });
      }

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
    } catch (err) {
      messageRecord.status = "Failed";
      messageRecord.provider = adapter.channelName;
      messageRecord.errorDetails = { message: err.message };
      messageRecord.dlqId = err.dlqId || null;
      await messageRecord.save();

      await this._logAudit({
        tenantId: messageRecord.tenantId,
        messageId: messageRecord.messageId,
        event: "CommunicationFailed",
        channel: messageRecord.channel,
        details: { error: err.message, dlqId: err.dlqId || null }
      });

      publishEvent("CommunicationFailed", {
        tenantId: messageRecord.tenantId,
        messageId: messageRecord.messageId,
        channel: messageRecord.channel,
        reason: err.message,
        dlqId: err.dlqId || null
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
   * Communication Platform (Part 11 fix, gap 2.6) — automated sweep of
   * 'Failed' messages, mirroring WebhookRetryScheduler/WebhookService's own
   * division of responsibility: services/communicationRetryScheduler.js is
   * a thin cron wrapper, this is the real business logic (and the unit-
   * tested surface — tests/communicationRetryScheduler.test.js). A message
   * only reaches `status: "Failed"` after the SAME-REQUEST inline
   * resilience-engine backoff (utils/communicationResilience.js) already
   * gave up; this sweep gives it one more full attempt later, once a
   * provider outage may have cleared — the actual `retryCount >=
   * maxRetries` ceiling (still enforced by `retryMessage` above) is what
   * stops this from retrying forever. `communicationRetryCooldownMs`
   * avoids re-sweeping a message within the same window it just failed in.
   */
  static async processDueRetries() {
    const config = getFinanceConfig();
    const cutoff = new Date(Date.now() - config.communicationRetryCooldownMs);
    const due = await CommunicationMessageModel.find({
      status: "Failed",
      updatedAt: { $lte: cutoff },
      $expr: { $lt: ["$retryCount", "$maxRetries"] }
    }).limit(config.communicationRetryPollBatchSize).lean();

    let processed = 0;
    let skippedSuspended = 0;
    for (const messageLean of due) {
      try {
        const block = await TenantSubscriptionService.getEnforcementBlock(messageLean.tenantId);
        if (block) { skippedSuspended += 1; continue; }

        await this.retryMessage({ tenantId: messageLean.tenantId, messageId: messageLean.messageId, userId: "system" });
        processed += 1;
      } catch (error) {
        logger.error("Communication retry sweep item failed", { messageId: messageLean.messageId, error: error.message });
      }
    }

    if (skippedSuspended > 0) logger.info(`Communication retry sweep skipped ${skippedSuspended} message(s) — tenant suspended.`);
    return processed;
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
   * Channel Analytics Summary — Part 14 fix: reads the scheduled/event-driven
   * CommunicationAnalyticsEngine summary (cached, persisted read-model)
   * instead of running five live countDocuments queries against the
   * transactional CommunicationMessageModel collection on every dashboard hit.
   */
  static async getCommunicationAnalytics({ tenantId }) {
    if (!tenantId) throw new Error("tenantId is required.");
    return CommunicationAnalyticsEngine.getCommunicationAnalytics({ tenantId });
  }

  // ── Part 15 fix — Data Retention & Legal Hold (Enterprise Architecture
  // Hardening Phase, Improvement 11). Thin pass-throughs to the SAME shared
  // engine every other archivable record in this codebase uses
  // (utils/archivalService.js / utils/legalHold.js) — not a second,
  // Communication-specific retention mechanism. Permission-gating who may
  // call these (e.g. `communication.message.archive`) is the caller/
  // controller's responsibility, matching this codebase's convention
  // everywhere else. `resourceId` is the message's own real `messageId`
  // throughout, kept consistent across archive/hold/read so a legal hold
  // applied here is found by the exact same identifier later. ──

  static async archiveMessage({ tenantId, messageId, reason, userId = null }) {
    if (!messageId) throw new Error("messageId is required.");
    return archiveRecord({ Model: CommunicationMessageModel, filter: { tenantId, messageId }, resourceType: "CommunicationMessage", reason, userId, tenantId });
  }

  static async restoreMessage({ tenantId, messageId, userId = null }) {
    if (!messageId) throw new Error("messageId is required.");
    return restoreRecord({ Model: CommunicationMessageModel, filter: { tenantId, messageId }, resourceType: "CommunicationMessage", userId, tenantId });
  }

  /** Requires the message to already be Archived, under no active legal hold, and past its retention period — see purgeRecord's own real checks. */
  static async purgeMessage({ tenantId, messageId, approvedBy, userId = null, reason = null }) {
    if (!messageId) throw new Error("messageId is required.");
    return purgeRecord({ Model: CommunicationMessageModel, filter: { tenantId, messageId }, resourceType: "CommunicationMessage", approvedBy, userId, tenantId, reason });
  }

  static async applyMessageLegalHold({ tenantId, messageId, reason, userId = null }) {
    if (!messageId) throw new Error("messageId is required.");
    return applyLegalHold({ Model: CommunicationMessageModel, filter: { tenantId, messageId }, resourceType: "CommunicationMessage", resourceId: messageId, reason, userId, tenantId });
  }

  static async removeMessageLegalHold({ tenantId, messageId, holdId, userId = null, removalReason = null }) {
    if (!messageId) throw new Error("messageId is required.");
    return removeLegalHold({ Model: CommunicationMessageModel, filter: { tenantId, messageId }, resourceType: "CommunicationMessage", resourceId: messageId, holdId, userId, tenantId, removalReason });
  }

  static async getMessageLegalHoldStatus({ tenantId, messageId }) {
    if (!messageId) throw new Error("messageId is required.");
    return getLegalHoldStatus(tenantId, "CommunicationMessage", messageId);
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
      publishEvent("CommunicationAuditCreated", { tenantId, auditId: audit.auditId });
    } catch (err) {
      console.error("Communication audit log failure:", err);
    }
  }
}

export default CommunicationPlatformService;
