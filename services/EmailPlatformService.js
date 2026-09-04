import CommunicationMessageModel from "../models/CommunicationMessageModel.js";
import CommunicationAuditModel from "../models/CommunicationAuditModel.js";
import CommunicationTemplateService from "./CommunicationTemplateService.js";
import CommunicationPreferenceService from "./CommunicationPreferenceService.js";
import { getDeliveryAdapter } from "./delivery/index.js";
import { publishEvent } from "../utils/eventBus.js";
import { dispatchCommunicationWithResilience } from "../utils/communicationResilience.js";

// The same Email ProviderRouter (Part 13) the generic Communication
// Platform dispatch path uses — not a second, separately-constructed
// adapter — so a future second Email provider is visible from this Part 2
// path too without any change here.
const emailChannelRouter = getDeliveryAdapter("Email");

/**
 * Enterprise Email Platform Service — Part 2.
 * High-performance email queueing, variable rendering, provider failover, delivery tracking, and event publishing.
 * Tenant-scoped only — no branchId per Master Architecture rules.
 */
class EmailPlatformService {
  static generateId(prefix = "EML") {
    const timestamp = Date.now().toString(36).toUpperCase();
    const random = Math.random().toString(36).substring(2, 6).toUpperCase();
    return `${prefix}-${timestamp}-${random}`;
  }

  /**
   * Queue & Send Email Across Business Modules (CRM, Finance, Booking, Visa, HR, AI)
   */
  static async sendEmail({
    tenantId,
    template = null,
    templateId = null,
    to,
    variables = {},
    templateData = {},
    locale = "en",
    subject = null,
    content = null,
    body = null,
    attachments = [],
    emailType = "Transactional",
    sourceModule = "System",
    priority = "Normal",
    scheduledAt = null,
    idempotencyKey = null,
    userId = null
  }) {
    if (!tenantId) throw new Error("tenantId is required.");
    if (!to || (Array.isArray(to) && to.length === 0)) {
      throw new Error("Recipient email (to) is required.");
    }

    const recipients = Array.isArray(to) ? to : [to];

    // 1. Idempotency Check
    if (idempotencyKey) {
      const existing = await CommunicationMessageModel.findOne({ tenantId, idempotencyKey }).lean();
      if (existing) {
        return {
          trackingId: existing.trackingId || existing.messageId,
          messageId: existing.messageId,
          status: existing.status,
          recipients: existing.recipients.length > 0 ? existing.recipients : [existing.recipient?.email],
          template: existing.templateId,
          subject: existing.subject,
          emailType: existing.emailType || "Transactional",
          provider: existing.provider,
          queuedAt: existing.createdAt
        };
      }
    }

    // 2. Preference & DND Enforcement Check for User Recipient if specified
    const targetUserId = userId;
    if (targetUserId) {
      const prefCheck = await CommunicationPreferenceService.canSendToUser({
        tenantId,
        userId: targetUserId,
        channel: "Email"
      });
      if (!prefCheck.allowed) {
        throw new Error(`Email delivery blocked by user preference or DND: ${prefCheck.reason}`);
      }
    }

    // 3. Resolve Template & Variable Rendering
    let finalSubject = subject;
    let finalContent = content || body;
    const targetTemplateId = template || templateId;

    if (targetTemplateId) {
      // Part 8 fix — only an approved ("Active") template may be resolved for a real send.
      const tpl = await CommunicationTemplateService.getPublishedTemplateForSend({ tenantId, templateId: targetTemplateId, locale });
      const mergedVars = { ...variables, ...templateData };
      finalSubject = CommunicationTemplateService.renderTemplate(tpl.subjectTemplate || subject || "Notification", mergedVars);
      finalContent = CommunicationTemplateService.renderTemplate(tpl.bodyTemplate, mergedVars);
    }

    if (!finalContent && !targetTemplateId) {
      throw new Error("Email body/content or valid template must be provided.");
    }

    // 4. Validate Attachments Size
    const parsedAttachments = attachments.map((att) => {
      if (typeof att === "string") {
        return { filename: att, path: att };
      }
      if (att.size && att.size > 25 * 1024 * 1024) {
        throw new Error(`Attachment ${att.filename} exceeds maximum allowed size of 25MB.`);
      }
      return att;
    });

    const trackingId = this.generateId("EML");
    const messageId = trackingId;
    const isScheduled = scheduledAt && new Date(scheduledAt) > new Date();

    // 5. Save Record
    const emailRecord = new CommunicationMessageModel({
      tenantId,
      messageId,
      trackingId,
      sourceModule,
      channel: "Email",
      recipient: {
        email: recipients[0],
        userId: targetUserId
      },
      recipients,
      templateId: targetTemplateId,
      templateData: { ...variables, ...templateData },
      subject: finalSubject || "No Subject",
      content: finalContent,
      attachments: parsedAttachments,
      emailType,
      status: isScheduled ? "Queued" : "Processing",
      priority,
      scheduledAt: scheduledAt ? new Date(scheduledAt) : new Date(),
      idempotencyKey,
      createdBy: userId
    });

    await emailRecord.save();

    // 6. Domain Event Publishing
    publishEvent("EmailRequested", { tenantId, trackingId, sourceModule, recipients, emailType });
    publishEvent("EmailQueued", { tenantId, trackingId, sourceModule, recipients, isScheduled });

    await this._logAudit({
      tenantId,
      messageId: trackingId,
      // CommunicationAuditModel's own `event` enum is the generic
      // "Communication*" vocabulary shared by every channel (see
      // models/CommunicationAuditModel.js) — a channel-prefixed value here
      // ("EmailRequested") fails schema validation and the row silently
      // never saves. The channel itself is already a separate field on the
      // same row; it doesn't need to be repeated in `event` too.
      event: isScheduled ? "CommunicationQueued" : "CommunicationRequested",
      details: { recipients, subject: finalSubject, emailType, sourceModule }
    });

    if (isScheduled) {
      return {
        trackingId,
        messageId: trackingId,
        status: "Queued",
        recipients,
        template: targetTemplateId,
        subject: finalSubject,
        emailType,
        queuedAt: emailRecord.createdAt
      };
    }

    // 7. Dispatch via Email Delivery Adapter Layer — retry-with-backoff +
    // circuit breaker + Dead Letter Queue hand-off on exhaustion/permanent
    // failure (Part 11 fix), not a one-shot call with manual-retry-only recovery.
    try {
      const result = await dispatchCommunicationWithResilience({
        channel: "Email",
        tenantId,
        messageId: trackingId,
        sourceModule,
        idempotencyKey,
        recipient: { email: recipients[0], userId: targetUserId },
        run: async () => {
          const sendResult = await emailChannelRouter.send({
            tenantId,
            messageId: trackingId,
            to: recipients.join(", "),
            subject: finalSubject,
            body: finalContent,
            attachment: parsedAttachments[0] || null
          });
          if (sendResult.status !== "Sent") {
            throw new Error(sendResult.failureReason || "Provider delivery failed.");
          }
          return sendResult;
        }
      });

      // CommunicationMessageModel's own status enum has no "Sent" value —
      // "Delivered" is the terminal-success state every other channel
      // (CommunicationPlatformService/SmsPlatformService/WhatsAppPlatformService)
      // already uses; setting "Sent" here failed schema validation on save,
      // silently mis-recording every successful email as "Failed".
      emailRecord.status = "Delivered";
      emailRecord.deliveredAt = new Date();
      emailRecord.provider = result.provider || "Nodemailer SMTP";
      emailRecord.providerResponse = result.providerResponse || {};
      await emailRecord.save();

      publishEvent("EmailSent", { tenantId, trackingId, provider: emailRecord.provider });
      publishEvent("EmailDelivered", { tenantId, trackingId, provider: emailRecord.provider });

      await this._logAudit({
        tenantId,
        messageId: trackingId,
        event: "CommunicationDelivered",
        provider: emailRecord.provider,
        details: result
      });
    } catch (deliveryErr) {
      emailRecord.status = "Failed";
      emailRecord.errorDetails = { message: deliveryErr.message };
      emailRecord.dlqId = deliveryErr.dlqId || null;
      await emailRecord.save();

      publishEvent("EmailFailed", { tenantId, trackingId, reason: deliveryErr.message, dlqId: deliveryErr.dlqId || null });

      await this._logAudit({
        tenantId,
        messageId: trackingId,
        event: "CommunicationFailed",
        details: { error: deliveryErr.message, dlqId: deliveryErr.dlqId || null }
      });
    }

    return {
      trackingId,
      messageId: trackingId,
      status: emailRecord.status,
      recipients,
      template: targetTemplateId,
      subject: finalSubject,
      emailType,
      provider: emailRecord.provider,
      queuedAt: emailRecord.createdAt
    };
  }

  /**
   * Get Email Delivery Status by Tracking ID
   */
  static async getEmailTrackingStatus({ tenantId, trackingId }) {
    if (!tenantId || !trackingId) throw new Error("tenantId and trackingId are required.");

    const email = await CommunicationMessageModel.findOne({
      tenantId,
      $or: [{ trackingId }, { messageId: trackingId }],
      channel: "Email"
    }).lean();

    if (!email) {
      throw new Error(`Email tracking record not found for ID: ${trackingId}`);
    }

    return {
      trackingId: email.trackingId || email.messageId,
      recipients: email.recipients?.length > 0 ? email.recipients : [email.recipient?.email],
      template: email.templateId,
      subject: email.subject,
      emailType: email.emailType || "Transactional",
      status: email.status,
      provider: email.provider || "Nodemailer SMTP",
      sentTime: email.createdAt,
      deliveredTime: email.deliveredAt,
      openCount: email.openCount || 0,
      clickCount: email.clickCount || 0,
      bounceStatus: email.bounceStatus || "None",
      bounceReason: email.bounceReason || null,
      errorDetails: email.errorDetails || null
    };
  }

  static async _logAudit({ tenantId, messageId, event, provider = null, details = {} }) {
    try {
      const audit = new CommunicationAuditModel({
        tenantId,
        auditId: this.generateId("AUD"),
        messageId,
        event,
        channel: "Email",
        provider,
        details
      });
      await audit.save();
      publishEvent("CommunicationAuditCreated", { tenantId, auditId: audit.auditId });
    } catch (err) {
      console.error("Email audit log failed:", err.message);
    }
  }
}

export default EmailPlatformService;
