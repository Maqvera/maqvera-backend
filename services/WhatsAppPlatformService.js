import CommunicationMessageModel from "../models/CommunicationMessageModel.js";
import CommunicationAuditModel from "../models/CommunicationAuditModel.js";
import CommunicationTemplateService from "./CommunicationTemplateService.js";
import CommunicationPreferenceService from "./CommunicationPreferenceService.js";
import WhatsAppConversationService from "./WhatsAppConversationService.js";
import { getDeliveryAdapter } from "./delivery/index.js";
import { validatePhoneNumber, formatPhoneNumber } from "../utils/smsHelper.js";
import { publishEvent } from "../utils/eventBus.js";
import { dispatchCommunicationWithResilience } from "../utils/communicationResilience.js";

// The same WhatsApp ProviderRouter (Part 13) the generic Communication
// Platform dispatch path uses — not a second, separately-constructed
// adapter — so a future second WhatsApp provider (Meta Cloud/360dialog) is
// visible from this Part 4 path too without any change here.
const whatsAppChannelRouter = getDeliveryAdapter("WhatsApp");

/**
 * Enterprise WhatsApp Platform Service — Part 4.
 * The dedicated WhatsApp entry point every business module should call
 * (mirrors services/SmsPlatformService.js's structure — the closest existing
 * pattern: validated recipient -> template/free-form resolution -> resilient
 * dispatch -> tracking), instead of a feature (e.g. Package) owning its own
 * WhatsApp logic. Every send — templated or free-form — is checked against
 * WhatsAppConversationService's 24-hour conversation-window rule: a
 * free-form send outside the window is refused, never silently allowed
 * (real enforcement of Meta's WhatsApp Business policy, not just a doc note).
 * Tenant-scoped only — no branchId per Master Architecture rules.
 */
class WhatsAppPlatformService {
  static generateId(prefix = "WA") {
    const timestamp = Date.now().toString(36).toUpperCase();
    const random = Math.random().toString(36).substring(2, 6).toUpperCase();
    return `${prefix}-${timestamp}-${random}`;
  }

  /**
   * Primary entry point for sending a WhatsApp message.
   * Pass `templateId` for an outside-window send (Meta-approved-template
   * equivalent); omit it only when the conversation window is known open.
   */
  static async sendWhatsApp({
    tenantId,
    phone,
    templateId = null,
    templateData = {},
    locale = "en",
    content = null,
    sourceModule = "System",
    priority = "Normal",
    scheduledAt = null,
    idempotencyKey = null,
    userId = null
  }) {
    if (!tenantId) throw new Error("tenantId is required.");
    if (!phone) throw new Error("Recipient phone number is required.");

    const formattedPhone = formatPhoneNumber(phone);
    if (!validatePhoneNumber(formattedPhone)) {
      throw new Error(`Invalid phone number format: ${phone}. Must be in E.164 format (e.g. +923001234567).`);
    }

    // 1. Idempotency Check
    if (idempotencyKey) {
      const existing = await CommunicationMessageModel.findOne({ tenantId, idempotencyKey }).lean();
      if (existing) {
        return {
          trackingId: existing.trackingId || existing.messageId,
          messageId: existing.messageId,
          phone: formattedPhone,
          status: existing.status,
          provider: existing.provider,
          queuedAt: existing.createdAt
        };
      }
    }

    // 2. Preference & DND Enforcement
    if (userId) {
      const prefCheck = await CommunicationPreferenceService.canSendToUser({ tenantId, userId, channel: "WhatsApp", priority });
      if (!prefCheck.allowed) {
        throw new Error(`WhatsApp delivery blocked by user preference or DND: ${prefCheck.reason}`);
      }
    }

    // 3. Template Resolution OR Conversation-Window Compliance Gate
    let finalContent = content;
    if (templateId) {
      // Part 8 fix — only an approved ("Active") template may be resolved for a real send.
      const tpl = await CommunicationTemplateService.getPublishedTemplateForSend({ tenantId, templateId, locale });
      finalContent = CommunicationTemplateService.renderTemplate(tpl.bodyTemplate, templateData);
    } else {
      await WhatsAppConversationService.assertCanSendFreeform({ tenantId, phone: formattedPhone });
    }

    if (!finalContent) {
      throw new Error("WhatsApp message content or a valid templateId must be provided.");
    }

    const trackingId = this.generateId("WA");
    const messageId = trackingId;
    const isScheduled = scheduledAt && new Date(scheduledAt) > new Date();

    // 4. Save Communication Message Record
    const waRecord = new CommunicationMessageModel({
      tenantId,
      messageId,
      trackingId,
      sourceModule,
      channel: "WhatsApp",
      recipient: { phone: formattedPhone, userId: userId || null },
      phone: formattedPhone,
      templateId,
      templateData,
      subject: `WhatsApp - ${sourceModule}`,
      content: finalContent,
      status: isScheduled ? "Queued" : "Processing",
      priority,
      scheduledAt: scheduledAt ? new Date(scheduledAt) : new Date(),
      idempotencyKey,
      createdBy: userId
    });

    await waRecord.save();

    publishEvent(isScheduled ? "WhatsAppQueued" : "WhatsAppRequested", { tenantId, trackingId, phone: formattedPhone, isScheduled });

    await this._logAudit({
      tenantId,
      messageId: trackingId,
      event: isScheduled ? "CommunicationQueued" : "CommunicationRequested",
      details: { phone: formattedPhone, templateId }
    });

    if (isScheduled) {
      return {
        trackingId,
        messageId: trackingId,
        phone: formattedPhone,
        status: "Queued",
        priority,
        queuedAt: waRecord.createdAt
      };
    }

    // 5. Dispatch — retry-with-backoff + circuit breaker + Dead Letter Queue
    // hand-off on exhaustion/permanent failure (same shared resilience
    // engine every other channel now uses).
    try {
      const result = await dispatchCommunicationWithResilience({
        channel: "WhatsApp",
        tenantId,
        messageId: trackingId,
        sourceModule,
        idempotencyKey,
        recipient: waRecord.recipient,
        run: async () => {
          const sendResult = await whatsAppChannelRouter.send({ tenantId, messageId: trackingId, to: formattedPhone, body: finalContent });
          if (sendResult.status !== "Sent") {
            throw new Error(sendResult.failureReason || "WhatsApp delivery failed.");
          }
          return sendResult;
        }
      });

      waRecord.status = "Delivered";
      waRecord.deliveredAt = new Date();
      waRecord.provider = result.provider || "Twilio WhatsApp";
      waRecord.providerResponse = result.providerResponse || {};
      await waRecord.save();

      await WhatsAppConversationService.recordOutboundMessage({ tenantId, phone: formattedPhone });

      publishEvent("WhatsAppDelivered", { tenantId, trackingId, provider: waRecord.provider });
      await this._logAudit({ tenantId, messageId: trackingId, event: "CommunicationDelivered", provider: waRecord.provider, details: result });
    } catch (dispatchErr) {
      waRecord.status = "Failed";
      waRecord.errorDetails = { message: dispatchErr.message };
      waRecord.dlqId = dispatchErr.dlqId || null;
      await waRecord.save();

      publishEvent("WhatsAppFailed", { tenantId, trackingId, reason: dispatchErr.message, dlqId: dispatchErr.dlqId || null });
      await this._logAudit({ tenantId, messageId: trackingId, event: "CommunicationFailed", details: { reason: dispatchErr.message, dlqId: dispatchErr.dlqId || null } });
    }

    return {
      trackingId,
      messageId: trackingId,
      phone: formattedPhone,
      status: waRecord.status,
      provider: waRecord.provider,
      failureReason: waRecord.errorDetails?.message || null,
      queuedAt: waRecord.createdAt
    };
  }

  static async getWhatsAppTrackingStatus({ tenantId, trackingId }) {
    if (!tenantId || !trackingId) throw new Error("tenantId and trackingId are required.");

    const wa = await CommunicationMessageModel.findOne({
      tenantId,
      $or: [{ trackingId }, { messageId: trackingId }],
      channel: "WhatsApp"
    }).lean();

    if (!wa) throw new Error(`WhatsApp tracking record not found for ID: ${trackingId}`);

    return {
      trackingId: wa.trackingId || wa.messageId,
      phone: wa.phone,
      status: wa.status,
      provider: wa.provider,
      deliveredAt: wa.deliveredAt,
      failureReason: wa.errorDetails?.message || null,
      dlqId: wa.dlqId || null,
      createdAt: wa.createdAt
    };
  }

  static async _logAudit({ tenantId, messageId, event, provider = null, details = {} }) {
    try {
      const audit = new CommunicationAuditModel({
        tenantId,
        auditId: this.generateId("AUD"),
        messageId,
        event,
        channel: "WhatsApp",
        provider,
        details
      });
      await audit.save();
      publishEvent("CommunicationAuditCreated", { tenantId, auditId: audit.auditId });
    } catch (err) {
      console.error("WhatsApp audit log failure:", err);
    }
  }
}

export default WhatsAppPlatformService;
