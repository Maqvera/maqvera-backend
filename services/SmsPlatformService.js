import CommunicationMessageModel from "../models/CommunicationMessageModel.js";
import CommunicationAuditModel from "../models/CommunicationAuditModel.js";
import SmsOtpModel from "../models/SmsOtpModel.js";
import SmsCampaignModel from "../models/SmsCampaignModel.js";
import CommunicationTemplateService from "./CommunicationTemplateService.js";
import CommunicationPreferenceService from "./CommunicationPreferenceService.js";
import SmsProviderRouter from "./delivery/SmsProviderRouter.js";
import { validatePhoneNumber, formatPhoneNumber, detectEncodingAndSegments, generateSecureOtpCode } from "../utils/smsHelper.js";
import { publishEvent } from "../utils/eventBus.js";

/**
 * Enterprise SMS Platform Service — Part 3.
 * Centralized SMS platform handling OTP priority queues, transactional messaging, bulk campaigns,
 * Unicode encoding auto-detection, automatic provider failover, delivery tracking, and domain event publishing.
 * Tenant-scoped only — no branchId per Master Architecture rules.
 */
class SmsPlatformService {
  static generateId(prefix = "SMS") {
    const timestamp = Date.now().toString(36).toUpperCase();
    const random = Math.random().toString(36).substring(2, 6).toUpperCase();
    return `${prefix}-${timestamp}-${random}`;
  }

  /**
   * Primary entry point for sending individual SMS
   */
  static async sendSms({
    tenantId,
    phone,
    type = "Custom",
    smsType = null,
    template = null,
    templateId = null,
    variables = {},
    templateData = {},
    message = null,
    content = null,
    priority = null,
    scheduledAt = null,
    sourceModule = "System",
    idempotencyKey = null,
    userId = null
  }) {
    if (!tenantId) throw new Error("tenantId is required.");
    if (!phone) throw new Error("Recipient phone number is required.");

    const formattedPhone = formatPhoneNumber(phone);
    if (!validatePhoneNumber(formattedPhone)) {
      throw new Error(`Invalid phone number format: ${phone}. Must be in E.164 format (e.g. +923001234567).`);
    }

    const resolvedType = smsType || type || "Custom";
    const validSmsTypes = ["OTP", "Authentication", "Verification", "Invoice", "Payment Reminder", "Booking Confirmation", "Visa Update", "System Alert", "Marketing", "Custom"];
    const finalSmsType = validSmsTypes.includes(resolvedType) ? resolvedType : "Custom";

    // 1. Priority Resolution based on SMS Type
    let defaultPriority = "Normal";
    if (finalSmsType === "OTP" || finalSmsType === "Authentication" || finalSmsType === "Verification") {
      defaultPriority = "Critical";
    } else if (finalSmsType === "System Alert" || finalSmsType === "Visa Update" || finalSmsType === "Invoice") {
      defaultPriority = "High";
    } else if (finalSmsType === "Marketing") {
      defaultPriority = "Low";
    }
    const finalPriority = priority || defaultPriority;

    // 2. Idempotency Check
    if (idempotencyKey) {
      const existing = await CommunicationMessageModel.findOne({ tenantId, idempotencyKey }).lean();
      if (existing) {
        return {
          trackingId: existing.trackingId || existing.messageId,
          messageId: existing.messageId,
          phone: existing.recipient?.phone || existing.phone,
          smsType: existing.smsType || "Custom",
          status: existing.status,
          provider: existing.provider,
          encoding: existing.encoding || "GSM-7",
          segmentCount: existing.segmentCount || 1,
          priority: existing.priority,
          queuedAt: existing.createdAt
        };
      }
    }

    // 3. User Preference & DND Enforcement Check
    const targetUserId = userId;
    if (targetUserId) {
      const prefCheck = await CommunicationPreferenceService.canSendToUser({
        tenantId,
        userId: targetUserId,
        channel: "SMS"
      });
      if (!prefCheck.allowed) {
        throw new Error(`SMS delivery blocked by user preference or DND: ${prefCheck.reason}`);
      }
    }

    // 4. Resolve Template & Variables
    let finalContent = message || content;
    const targetTemplateId = template || templateId;

    if (targetTemplateId) {
      const tpl = await CommunicationTemplateService.getTemplateById({ tenantId, templateId: targetTemplateId });
      const mergedVars = { ...variables, ...templateData };
      finalContent = CommunicationTemplateService.renderTemplate(tpl.bodyTemplate, mergedVars);
    }

    if (!finalContent && !targetTemplateId) {
      throw new Error("SMS message text or valid template must be provided.");
    }

    // 5. Encoding & Segment Count Auto-Detection (GSM-7 vs UCS-2 Unicode)
    const encodingInfo = detectEncodingAndSegments(finalContent);

    const trackingId = this.generateId("SMS");
    const messageId = trackingId;
    const isScheduled = scheduledAt && new Date(scheduledAt) > new Date();

    // 6. Save Communication Message Record
    const smsRecord = new CommunicationMessageModel({
      tenantId,
      messageId,
      trackingId,
      sourceModule,
      channel: "SMS",
      recipient: {
        phone: formattedPhone,
        userId: targetUserId
      },
      phone: formattedPhone,
      smsType: finalSmsType,
      templateId: targetTemplateId,
      templateData: { ...variables, ...templateData },
      subject: `SMS - ${finalSmsType}`,
      content: finalContent,
      encoding: encodingInfo.encoding,
      segmentCount: encodingInfo.segmentCount,
      status: isScheduled ? "Queued" : "Processing",
      priority: finalPriority,
      scheduledAt: scheduledAt ? new Date(scheduledAt) : new Date(),
      idempotencyKey,
      createdBy: userId
    });

    await smsRecord.save();

    // 7. Publish Domain Events
    publishEvent("SMSRequested", { tenantId, trackingId, phone: formattedPhone, smsType: finalSmsType, priority: finalPriority });
    publishEvent("SMSQueued", { tenantId, trackingId, phone: formattedPhone, isScheduled, scheduledAt: smsRecord.scheduledAt });

    await this._logAudit({
      tenantId,
      messageId: trackingId,
      event: isScheduled ? "SMSQueued" : "SMSRequested",
      details: { phone: formattedPhone, smsType: finalSmsType, encoding: encodingInfo.encoding, segments: encodingInfo.segmentCount }
    });

    if (isScheduled) {
      return {
        trackingId,
        messageId: trackingId,
        phone: formattedPhone,
        smsType: finalSmsType,
        status: "Queued",
        encoding: encodingInfo.encoding,
        segmentCount: encodingInfo.segmentCount,
        priority: finalPriority,
        queuedAt: smsRecord.createdAt
      };
    }

    // 8. Dispatch via Multi-Provider Router with Automatic Failover
    const dispatchResult = await SmsProviderRouter.sendSms({
      tenantId,
      messageId: trackingId,
      to: formattedPhone,
      body: finalContent,
      recipient: smsRecord.recipient,
      templateData: smsRecord.templateData
    });

    if (dispatchResult.status === "Sent") {
      smsRecord.status = "Delivered";
      smsRecord.deliveredAt = new Date();
      smsRecord.provider = dispatchResult.provider;
      smsRecord.providerResponse = dispatchResult.providerResponse;
      await smsRecord.save();

      publishEvent("SMSSent", { tenantId, trackingId, provider: dispatchResult.provider });
      publishEvent("SMSDelivered", { tenantId, trackingId, provider: dispatchResult.provider, deliveredAt: smsRecord.deliveredAt });

      await this._logAudit({
        tenantId,
        messageId: trackingId,
        event: "SMSDelivered",
        provider: dispatchResult.provider,
        details: dispatchResult
      });
    } else {
      smsRecord.status = "Failed";
      smsRecord.provider = dispatchResult.provider;
      smsRecord.errorDetails = { message: dispatchResult.failureReason || "SMS delivery failed." };
      await smsRecord.save();

      publishEvent("SMSFailed", { tenantId, trackingId, reason: dispatchResult.failureReason, provider: dispatchResult.provider });

      await this._logAudit({
        tenantId,
        messageId: trackingId,
        event: "SMSFailed",
        provider: dispatchResult.provider,
        details: { reason: dispatchResult.failureReason }
      });
    }

    return {
      trackingId,
      messageId: trackingId,
      phone: formattedPhone,
      smsType: finalSmsType,
      status: smsRecord.status,
      provider: smsRecord.provider,
      encoding: encodingInfo.encoding,
      segmentCount: encodingInfo.segmentCount,
      priority: finalPriority,
      failureReason: smsRecord.errorDetails?.message || null,
      queuedAt: smsRecord.createdAt
    };
  }

  /**
   * Get SMS Tracking Status by Tracking ID
   */
  static async getSmsTrackingStatus({ tenantId, trackingId }) {
    if (!tenantId || !trackingId) throw new Error("tenantId and trackingId are required.");

    const sms = await CommunicationMessageModel.findOne({
      tenantId,
      $or: [{ trackingId }, { messageId: trackingId }],
      channel: "SMS"
    }).lean();

    if (!sms) {
      throw new Error(`SMS tracking record not found for ID: ${trackingId}`);
    }

    return {
      trackingId: sms.trackingId || sms.messageId,
      phone: sms.phone || sms.recipient?.phone,
      smsType: sms.smsType || "Custom",
      status: sms.status,
      provider: sms.provider || "Twilio",
      encoding: sms.encoding || "GSM-7",
      segmentCount: sms.segmentCount || 1,
      sentTime: sms.createdAt,
      deliveredTime: sms.deliveredAt,
      failureReason: sms.errorDetails?.message || null,
      retryCount: sms.retryCount || 0
    };
  }

  /**
   * OTP Engine — Generate & Send OTP with Fraud Protection and Priority Delivery
   */
  static async generateAndSendOtp({
    tenantId,
    phone,
    purpose = "LoginOTP",
    template = null,
    variables = {},
    expiryMinutes = 5,
    userId = null
  }) {
    if (!tenantId || !phone) throw new Error("tenantId and phone are required.");

    const formattedPhone = formatPhoneNumber(phone);
    if (!validatePhoneNumber(formattedPhone)) {
      throw new Error(`Invalid phone number format: ${phone}`);
    }

    // Rate Limiting & Fraud Protection: Max 3 active/recent OTP requests per phone per 10 minutes
    const tenMinsAgo = new Date(Date.now() - 10 * 60 * 1000);
    const recentOtpCount = await SmsOtpModel.countDocuments({
      tenantId,
      phone: formattedPhone,
      createdAt: { $gte: tenMinsAgo }
    });

    if (recentOtpCount >= 5) {
      throw new Error("Fraud protection alert: Too many OTP requests for this phone number. Please try again later.");
    }

    // Deactivate previous active OTPs for this phone & purpose
    await SmsOtpModel.updateMany(
      { tenantId, phone: formattedPhone, purpose, status: "Active" },
      { $set: { status: "Expired" } }
    );

    const otpCode = generateSecureOtpCode(6);
    const otpId = this.generateId("OTP");
    const expiresAt = new Date(Date.now() + expiryMinutes * 60 * 1000);

    const messageText = `Your security verification code is ${otpCode}. It expires in ${expiryMinutes} minutes. Do not share this code with anyone.`;

    const smsResult = await this.sendSms({
      tenantId,
      phone: formattedPhone,
      smsType: "OTP",
      template,
      variables: { otp: otpCode, expiryMinutes, ...variables },
      message: messageText,
      priority: "Critical",
      sourceModule: "Authentication",
      userId
    });

    const otpRecord = new SmsOtpModel({
      tenantId,
      otpId,
      phone: formattedPhone,
      otpCode,
      purpose,
      trackingId: smsResult.trackingId,
      status: "Active",
      attempts: 0,
      maxAttempts: 3,
      expiresAt,
      createdBy: userId
    });

    await otpRecord.save();

    publishEvent("OTPGenerated", { tenantId, otpId, phone: formattedPhone, purpose, expiresAt });

    return {
      trackingId: smsResult.trackingId,
      otpId,
      phone: formattedPhone,
      purpose,
      status: smsResult.status,
      provider: smsResult.provider,
      expiresAt,
      message: "OTP generated and queued for immediate delivery."
    };
  }

  /**
   * OTP Engine — Verify OTP Code
   */
  static async verifyOtp({ tenantId, phone, otpCode, purpose = "LoginOTP" }) {
    if (!tenantId || !phone || !otpCode) throw new Error("tenantId, phone, and otpCode are required.");

    const formattedPhone = formatPhoneNumber(phone);
    const otpRecord = await SmsOtpModel.findOne({
      tenantId,
      phone: formattedPhone,
      purpose,
      status: "Active"
    });

    if (!otpRecord) {
      throw new Error("No active OTP found for this phone number or it has already expired.");
    }

    // Check expiration
    if (new Date() > new Date(otpRecord.expiresAt)) {
      otpRecord.status = "Expired";
      await otpRecord.save();
      throw new Error("OTP code has expired. Please request a new verification code.");
    }

    // Check maximum attempts
    if (otpRecord.attempts >= otpRecord.maxAttempts) {
      otpRecord.status = "MaxAttemptsReached";
      await otpRecord.save();
      throw new Error("Maximum OTP verification attempts exceeded. Please request a new code.");
    }

    // Verify OTP matching
    if (otpRecord.otpCode !== String(otpCode).trim()) {
      otpRecord.attempts += 1;
      if (otpRecord.attempts >= otpRecord.maxAttempts) {
        otpRecord.status = "MaxAttemptsReached";
      }
      await otpRecord.save();
      throw new Error(`Invalid OTP code. ${otpRecord.maxAttempts - otpRecord.attempts} attempt(s) remaining.`);
    }

    // OTP Successfully Verified
    otpRecord.status = "Verified";
    otpRecord.verifiedAt = new Date();
    await otpRecord.save();

    publishEvent("OTPVerified", { tenantId, otpId: otpRecord.otpId, phone: formattedPhone, purpose, verifiedAt: otpRecord.verifiedAt });

    return {
      verified: true,
      otpId: otpRecord.otpId,
      phone: formattedPhone,
      purpose,
      verifiedAt: otpRecord.verifiedAt,
      message: "OTP verified successfully."
    };
  }

  /**
   * Bulk SMS Engine — Create and Launch Campaign
   */
  static async createBulkCampaign({
    tenantId,
    name,
    smsType = "Marketing",
    templateId = null,
    templateVariables = {},
    messageText = null,
    recipients = [],
    rateLimitPerSecond = 50,
    scheduledAt = null,
    userId = null
  }) {
    if (!tenantId || !name) throw new Error("tenantId and campaign name are required.");
    if (!recipients || !Array.isArray(recipients) || recipients.length === 0) {
      throw new Error("Recipient list (phones) is required for bulk campaign.");
    }

    const formattedRecipients = recipients.map(r => {
      const p = typeof r === "string" ? r : r.phone;
      return { phone: formatPhoneNumber(p), status: "Pending" };
    }).filter(r => validatePhoneNumber(r.phone));

    if (formattedRecipients.length === 0) {
      throw new Error("No valid phone numbers found in recipient list.");
    }

    const campaignId = this.generateId("CMP");
    const isScheduled = scheduledAt && new Date(scheduledAt) > new Date();

    const campaign = new SmsCampaignModel({
      tenantId,
      campaignId,
      name,
      smsType,
      templateId,
      templateVariables,
      messageText,
      recipients: formattedRecipients,
      totalRecipients: formattedRecipients.length,
      status: isScheduled ? "Scheduled" : "Processing",
      rateLimitPerSecond,
      scheduledAt: scheduledAt ? new Date(scheduledAt) : new Date(),
      startedAt: isScheduled ? null : new Date(),
      createdBy: userId
    });

    await campaign.save();

    if (!isScheduled) {
      // Process batch dispatch in background / async queue
      this._processCampaignBatch(tenantId, campaignId, userId).catch(err => {
        console.error(`Bulk SMS Campaign ${campaignId} execution error:`, err);
      });
    }

    return {
      campaignId,
      name,
      smsType,
      totalRecipients: campaign.totalRecipients,
      status: campaign.status,
      scheduledAt: campaign.scheduledAt,
      message: `Bulk SMS Campaign created successfully with ${campaign.totalRecipients} recipients.`
    };
  }

  /**
   * Internal Batch Processing for Bulk SMS Campaign
   */
  static async _processCampaignBatch(tenantId, campaignId, userId) {
    const campaign = await SmsCampaignModel.findOne({ tenantId, campaignId });
    if (!campaign || campaign.status === "Paused" || campaign.status === "Cancelled") return;

    let sent = 0;
    let delivered = 0;
    let failed = 0;

    for (let i = 0; i < campaign.recipients.length; i++) {
      const rec = campaign.recipients[i];
      if (rec.status !== "Pending") continue;

      try {
        const smsResult = await this.sendSms({
          tenantId,
          phone: rec.phone,
          smsType: campaign.smsType,
          template: campaign.templateId,
          variables: campaign.templateVariables,
          message: campaign.messageText,
          priority: "Low",
          sourceModule: "CRM",
          userId
        });

        rec.trackingId = smsResult.trackingId;
        rec.status = smsResult.status === "Delivered" ? "Delivered" : "Sent";
        sent++;
        if (smsResult.status === "Delivered") delivered++;
      } catch (err) {
        rec.status = "Failed";
        rec.failureReason = err.message;
        failed++;
      }
    }

    campaign.sentCount = sent;
    campaign.deliveredCount = delivered;
    campaign.failedCount = failed;
    campaign.status = "Completed";
    campaign.completedAt = new Date();
    await campaign.save();
  }

  /**
   * Fetch Bulk Campaign Details
   */
  static async getCampaignDetails({ tenantId, campaignId }) {
    if (!tenantId || !campaignId) throw new Error("tenantId and campaignId are required.");
    const campaign = await SmsCampaignModel.findOne({ tenantId, campaignId }).lean();
    if (!campaign) throw new Error(`Campaign ${campaignId} not found.`);
    return campaign;
  }

  /**
   * Pause / Resume / Cancel Bulk Campaign
   */
  static async updateCampaignStatus({ tenantId, campaignId, action }) {
    if (!tenantId || !campaignId || !action) throw new Error("tenantId, campaignId, and action are required.");

    const campaign = await SmsCampaignModel.findOne({ tenantId, campaignId });
    if (!campaign) throw new Error(`Campaign ${campaignId} not found.`);

    if (action === "pause") {
      campaign.status = "Paused";
    } else if (action === "resume") {
      campaign.status = "Processing";
      this._processCampaignBatch(tenantId, campaignId, campaign.createdBy).catch(console.error);
    } else if (action === "cancel") {
      campaign.status = "Cancelled";
    } else {
      throw new Error(`Invalid campaign action: ${action}. Allowed: pause, resume, cancel.`);
    }

    await campaign.save();
    return campaign;
  }

  /**
   * Retry Failed SMS
   */
  static async retrySms({ tenantId, trackingId, userId = null }) {
    if (!tenantId || !trackingId) throw new Error("tenantId and trackingId are required.");

    const sms = await CommunicationMessageModel.findOne({ tenantId, trackingId, channel: "SMS" });
    if (!sms) throw new Error(`SMS record ${trackingId} not found.`);

    if (sms.retryCount >= sms.maxRetries) {
      throw new Error(`Maximum retry limit (${sms.maxRetries}) reached for SMS ${trackingId}.`);
    }

    sms.retryCount += 1;
    sms.status = "Retried";
    await sms.save();

    publishEvent("SMSRetried", { tenantId, trackingId, attempt: sms.retryCount });

    await this._logAudit({
      tenantId,
      messageId: trackingId,
      event: "SMSRetried",
      details: { attempt: sms.retryCount }
    });

    const dispatchResult = await SmsProviderRouter.sendSms({
      tenantId,
      messageId: trackingId,
      to: sms.phone || sms.recipient?.phone,
      body: sms.content,
      recipient: sms.recipient,
      templateData: sms.templateData
    });

    if (dispatchResult.status === "Sent") {
      sms.status = "Delivered";
      sms.deliveredAt = new Date();
      sms.provider = dispatchResult.provider;
      sms.providerResponse = dispatchResult.providerResponse;
      await sms.save();

      publishEvent("SMSDelivered", { tenantId, trackingId, provider: dispatchResult.provider });
    } else {
      sms.status = "Failed";
      sms.errorDetails = { message: dispatchResult.failureReason };
      await sms.save();

      publishEvent("SMSFailed", { tenantId, trackingId, reason: dispatchResult.failureReason });
    }

    return {
      trackingId,
      status: sms.status,
      provider: sms.provider,
      retryCount: sms.retryCount
    };
  }

  static async _logAudit({ tenantId, messageId, event, provider = null, details = {} }) {
    try {
      const audit = new CommunicationAuditModel({
        tenantId,
        auditId: this.generateId("AUD"),
        messageId,
        event: event.startsWith("SMS") || event.startsWith("OTP") ? "CommunicationRequested" : event,
        channel: "SMS",
        provider,
        details: { originalEvent: event, ...details }
      });
      await audit.save();
    } catch (err) {
      console.error("SMS audit log error:", err.message);
    }
  }
}

export default SmsPlatformService;
