import CommunicationMessageModel from "../models/CommunicationMessageModel.js";
import CommunicationAuditModel from "../models/CommunicationAuditModel.js";
import CommunicationTemplateService from "./CommunicationTemplateService.js";
import CommunicationPreferenceService from "./CommunicationPreferenceService.js";
import EmailDeliveryAdapter from "./delivery/EmailDeliveryAdapter.js";
import { publishEvent } from "../utils/eventBus.js";

const emailDeliveryAdapter = new EmailDeliveryAdapter();

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
      const tpl = await CommunicationTemplateService.getTemplateById({ tenantId, templateId: targetTemplateId });
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
      event: isScheduled ? "EmailQueued" : "EmailRequested",
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

    // 7. Dispatch via Email Delivery Adapter Layer
    try {
      const result = await emailDeliveryAdapter.send({
        to: recipients.join(", "),
        subject: finalSubject,
        body: finalContent,
        attachment: parsedAttachments[0] || null
      });

      if (result.status === "Sent") {
        emailRecord.status = "Sent";
        emailRecord.deliveredAt = new Date();
        emailRecord.provider = result.provider || "Nodemailer SMTP";
        emailRecord.providerResponse = result.providerResponse || {};
        await emailRecord.save();

        publishEvent("EmailSent", { tenantId, trackingId, provider: emailRecord.provider });
        publishEvent("EmailDelivered", { tenantId, trackingId, provider: emailRecord.provider });

        await this._logAudit({
          tenantId,
          messageId: trackingId,
          event: "EmailDelivered",
          provider: emailRecord.provider,
          details: result
        });
      } else {
        emailRecord.status = "Failed";
        emailRecord.errorDetails = { message: result.failureReason || "Provider delivery failed." };
        await emailRecord.save();

        publishEvent("EmailFailed", { tenantId, trackingId, reason: result.failureReason });

        await this._logAudit({
          tenantId,
          messageId: trackingId,
          event: "EmailFailed",
          details: { reason: result.failureReason }
        });
      }
    } catch (deliveryErr) {
      emailRecord.status = "Failed";
      emailRecord.errorDetails = { message: deliveryErr.message };
      await emailRecord.save();

      publishEvent("EmailFailed", { tenantId, trackingId, reason: deliveryErr.message });

      await this._logAudit({
        tenantId,
        messageId: trackingId,
        event: "EmailFailed",
        details: { error: deliveryErr.message }
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
    } catch (err) {
      console.error("Email audit log failed:", err.message);
    }
  }
}

export default EmailPlatformService;
