import CommunicationPlatformService from "../services/CommunicationPlatformService.js";
import CommunicationTemplateService from "../services/CommunicationTemplateService.js";
import CommunicationPreferenceService from "../services/CommunicationPreferenceService.js";
import EmailPlatformService from "../services/EmailPlatformService.js";
import SmsPlatformService from "../services/SmsPlatformService.js";
import WhatsAppPlatformService from "../services/WhatsAppPlatformService.js";
import WhatsAppConversationService from "../services/WhatsAppConversationService.js";
import CommunicationAnalyticsEngine from "../services/CommunicationAnalyticsEngine.js";
import { sendError, sendSuccess } from "../utils/apiResponse.js";
import { getAccessScope } from "../utils/accessScope.js";
import { createRequestId } from "../utils/authTokens.js";

/**
 * Enterprise Communication Platform Controller — Part 1.
 * Centralized messaging, provider dispatch, template management, preference center, and analytics.
 * Tenant-scoped only — no branchId per Master Architecture rules.
 */

const getScope = (req) => {
  const accessScope = getAccessScope(req);
  return {
    tenantId: accessScope?.tenantId || null,
    userId: req.auth?.userId || req.auth?.id || null
  };
};

const statusFromError = (err) => {
  const msg = err.message || "";
  if (/not found/i.test(msg)) return 404;
  if (/required|invalid|missing/i.test(msg)) return 400;
  return 500;
};

// 1. Send / Request Message
export const requestCommunication = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const { tenantId, userId } = getScope(req);
    if (!tenantId) return sendError(res, 403, "Tenant context required.", requestId);

    const message = await CommunicationPlatformService.requestCommunication({
      tenantId,
      ...req.body,
      userId
    });

    const statusCode = message.status === "Delivered" ? 200 : message.status === "Queued" ? 202 : 201;
    return sendSuccess(res, statusCode, `Communication request processed (${message.status}).`, message, requestId);
  } catch (err) {
    return sendError(res, statusFromError(err), err.message, requestId);
  }
};

// 2. Query Messages History
export const listMessages = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const { tenantId } = getScope(req);
    if (!tenantId) return sendError(res, 403, "Tenant context required.", requestId);

    const { channel, status, sourceModule, page, limit } = req.query;
    const result = await CommunicationPlatformService.listMessages({
      tenantId,
      channel,
      status,
      sourceModule,
      page,
      limit
    });

    return sendSuccess(res, 200, "Communication messages retrieved successfully.", result, requestId);
  } catch (err) {
    return sendError(res, statusFromError(err), err.message, requestId);
  }
};

// 3. Get Single Message Details
export const getMessageById = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const { tenantId } = getScope(req);
    if (!tenantId) return sendError(res, 403, "Tenant context required.", requestId);

    const message = await CommunicationPlatformService.getMessageById({
      tenantId,
      messageId: req.params.messageId
    });

    return sendSuccess(res, 200, "Communication message retrieved successfully.", message, requestId);
  } catch (err) {
    return sendError(res, statusFromError(err), err.message, requestId);
  }
};

// 4. Retry Failed Message
export const retryMessage = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const { tenantId, userId } = getScope(req);
    if (!tenantId) return sendError(res, 403, "Tenant context required.", requestId);

    const message = await CommunicationPlatformService.retryMessage({
      tenantId,
      messageId: req.params.messageId,
      userId
    });

    return sendSuccess(res, 200, "Communication message retried successfully.", message, requestId);
  } catch (err) {
    return sendError(res, statusFromError(err), err.message, requestId);
  }
};

// 5. Cancel Message
export const cancelMessage = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const { tenantId } = getScope(req);
    if (!tenantId) return sendError(res, 403, "Tenant context required.", requestId);

    const message = await CommunicationPlatformService.cancelMessage({
      tenantId,
      messageId: req.params.messageId,
      reason: req.body?.reason || "User requested cancellation"
    });

    return sendSuccess(res, 200, "Communication message cancelled successfully.", message, requestId);
  } catch (err) {
    return sendError(res, statusFromError(err), err.message, requestId);
  }
};

// 5b. Retention & Legal Hold (Part 15) — permission-gating who may call
// these (e.g. `communication.message.archive`) is this route's own
// middleware/RBAC configuration, not this controller's concern.
export const archiveMessage = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const { tenantId, userId } = getScope(req);
    if (!tenantId) return sendError(res, 403, "Tenant context required.", requestId);

    const result = await CommunicationPlatformService.archiveMessage({
      tenantId, messageId: req.params.messageId, reason: req.body?.reason, userId
    });
    return sendSuccess(res, 200, "Communication message archived.", result, requestId);
  } catch (err) {
    return sendError(res, statusFromError(err), err.message, requestId);
  }
};

export const restoreMessage = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const { tenantId, userId } = getScope(req);
    if (!tenantId) return sendError(res, 403, "Tenant context required.", requestId);

    const result = await CommunicationPlatformService.restoreMessage({ tenantId, messageId: req.params.messageId, userId });
    return sendSuccess(res, 200, "Communication message restored.", result, requestId);
  } catch (err) {
    return sendError(res, statusFromError(err), err.message, requestId);
  }
};

export const purgeMessage = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const { tenantId, userId } = getScope(req);
    if (!tenantId) return sendError(res, 403, "Tenant context required.", requestId);

    const result = await CommunicationPlatformService.purgeMessage({
      tenantId, messageId: req.params.messageId, approvedBy: req.body?.approvedBy, userId, reason: req.body?.reason
    });
    return sendSuccess(res, 200, "Communication message permanently purged.", result, requestId);
  } catch (err) {
    return sendError(res, statusFromError(err), err.message, requestId);
  }
};

export const applyMessageLegalHold = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const { tenantId, userId } = getScope(req);
    if (!tenantId) return sendError(res, 403, "Tenant context required.", requestId);

    const result = await CommunicationPlatformService.applyMessageLegalHold({
      tenantId, messageId: req.params.messageId, reason: req.body?.reason, userId
    });
    return sendSuccess(res, 201, "Legal hold applied to communication message.", result, requestId);
  } catch (err) {
    return sendError(res, statusFromError(err), err.message, requestId);
  }
};

export const removeMessageLegalHold = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const { tenantId, userId } = getScope(req);
    if (!tenantId) return sendError(res, 403, "Tenant context required.", requestId);

    const result = await CommunicationPlatformService.removeMessageLegalHold({
      tenantId, messageId: req.params.messageId, holdId: req.body?.holdId, userId, removalReason: req.body?.removalReason
    });
    return sendSuccess(res, 200, "Legal hold removed from communication message.", result, requestId);
  } catch (err) {
    return sendError(res, statusFromError(err), err.message, requestId);
  }
};

export const getMessageLegalHoldStatus = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const { tenantId } = getScope(req);
    if (!tenantId) return sendError(res, 403, "Tenant context required.", requestId);

    const result = await CommunicationPlatformService.getMessageLegalHoldStatus({ tenantId, messageId: req.params.messageId });
    return sendSuccess(res, 200, "Legal hold status retrieved.", result, requestId);
  } catch (err) {
    return sendError(res, statusFromError(err), err.message, requestId);
  }
};

// 6. Communication Analytics Summary
export const getCommunicationAnalytics = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const { tenantId } = getScope(req);
    if (!tenantId) return sendError(res, 403, "Tenant context required.", requestId);

    const analytics = await CommunicationPlatformService.getCommunicationAnalytics({ tenantId });
    return sendSuccess(res, 200, "Communication platform analytics retrieved.", analytics, requestId);
  } catch (err) {
    return sendError(res, statusFromError(err), err.message, requestId);
  }
};

export const refreshCommunicationAnalytics = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const { tenantId } = getScope(req);
    if (!tenantId) return sendError(res, 403, "Tenant context required.", requestId);

    const analytics = await CommunicationAnalyticsEngine.refreshDashboard({ tenantId });
    return sendSuccess(res, 200, "Communication platform analytics refreshed.", analytics, requestId);
  } catch (err) {
    return sendError(res, statusFromError(err), err.message, requestId);
  }
};

// 7. Template Management
export const createTemplate = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const { tenantId, userId } = getScope(req);
    if (!tenantId) return sendError(res, 403, "Tenant context required.", requestId);

    const template = await CommunicationTemplateService.createTemplate({
      tenantId,
      ...req.body,
      userId
    });

    return sendSuccess(res, 201, "Communication template created successfully.", template, requestId);
  } catch (err) {
    return sendError(res, statusFromError(err), err.message, requestId);
  }
};

export const listTemplates = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const { tenantId } = getScope(req);
    if (!tenantId) return sendError(res, 403, "Tenant context required.", requestId);

    const { channel, status, locale, page, limit } = req.query;
    const result = await CommunicationTemplateService.listTemplates({
      tenantId,
      channel,
      status,
      locale,
      page,
      limit
    });

    return sendSuccess(res, 200, "Communication templates retrieved successfully.", result, requestId);
  } catch (err) {
    return sendError(res, statusFromError(err), err.message, requestId);
  }
};

export const getTemplateById = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const { tenantId } = getScope(req);
    if (!tenantId) return sendError(res, 403, "Tenant context required.", requestId);

    const template = await CommunicationTemplateService.getTemplateById({
      tenantId,
      templateId: req.params.templateId,
      locale: req.query.locale || "en"
    });

    return sendSuccess(res, 200, "Communication template retrieved successfully.", template, requestId);
  } catch (err) {
    return sendError(res, statusFromError(err), err.message, requestId);
  }
};

export const updateTemplate = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const { tenantId, userId } = getScope(req);
    if (!tenantId) return sendError(res, 403, "Tenant context required.", requestId);

    const { locale, ...updates } = req.body;
    const template = await CommunicationTemplateService.updateTemplate({
      tenantId,
      templateId: req.params.templateId,
      locale: locale || "en",
      updates,
      userId
    });

    return sendSuccess(res, 200, "Communication template updated successfully.", template, requestId);
  } catch (err) {
    return sendError(res, statusFromError(err), err.message, requestId);
  }
};

// Part 8 fix — approval gate. Permission-gating who may call approve/reject
// (e.g. `communication.template.approve`) is left to this route's own
// middleware/RBAC configuration, matching this codebase's convention that
// permission checks are the caller's responsibility, not this service's.
export const submitTemplateForReview = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const { tenantId, userId } = getScope(req);
    if (!tenantId) return sendError(res, 403, "Tenant context required.", requestId);

    const template = await CommunicationTemplateService.submitForReview({
      tenantId,
      templateId: req.params.templateId,
      locale: req.body?.locale || "en",
      userId
    });

    return sendSuccess(res, 200, "Communication template submitted for review.", template, requestId);
  } catch (err) {
    return sendError(res, statusFromError(err), err.message, requestId);
  }
};

export const approveTemplate = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const { tenantId, userId } = getScope(req);
    if (!tenantId) return sendError(res, 403, "Tenant context required.", requestId);

    const template = await CommunicationTemplateService.approveTemplate({
      tenantId,
      templateId: req.params.templateId,
      locale: req.body?.locale || "en",
      userId
    });

    return sendSuccess(res, 200, "Communication template approved and is now live.", template, requestId);
  } catch (err) {
    return sendError(res, statusFromError(err), err.message, requestId);
  }
};

export const rejectTemplate = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const { tenantId, userId } = getScope(req);
    if (!tenantId) return sendError(res, 403, "Tenant context required.", requestId);

    const template = await CommunicationTemplateService.rejectTemplate({
      tenantId,
      templateId: req.params.templateId,
      locale: req.body?.locale || "en",
      userId,
      reason: req.body?.reason
    });

    return sendSuccess(res, 200, "Communication template rejected.", template, requestId);
  } catch (err) {
    return sendError(res, statusFromError(err), err.message, requestId);
  }
};

export const listTemplateLocales = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const { tenantId } = getScope(req);
    if (!tenantId) return sendError(res, 403, "Tenant context required.", requestId);

    const locales = await CommunicationTemplateService.listTemplateLocales({
      tenantId,
      templateId: req.params.templateId
    });

    return sendSuccess(res, 200, "Communication template locale variants retrieved.", locales, requestId);
  } catch (err) {
    return sendError(res, statusFromError(err), err.message, requestId);
  }
};

export const listTemplateVersions = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const { tenantId } = getScope(req);
    if (!tenantId) return sendError(res, 403, "Tenant context required.", requestId);

    const versions = await CommunicationTemplateService.listTemplateVersions({
      tenantId,
      templateId: req.params.templateId,
      locale: req.query.locale || "en"
    });

    return sendSuccess(res, 200, "Communication template version history retrieved.", versions, requestId);
  } catch (err) {
    return sendError(res, statusFromError(err), err.message, requestId);
  }
};

export const rollbackTemplate = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const { tenantId, userId } = getScope(req);
    if (!tenantId) return sendError(res, 403, "Tenant context required.", requestId);

    const template = await CommunicationTemplateService.rollbackTemplate({
      tenantId,
      templateId: req.params.templateId,
      locale: req.body?.locale || "en",
      toVersion: req.body?.toVersion,
      userId
    });

    return sendSuccess(res, 200, `Communication template rolled back to version ${req.body?.toVersion}.`, template, requestId);
  } catch (err) {
    return sendError(res, statusFromError(err), err.message, requestId);
  }
};

// 8. User Communication Preferences
export const getUserPreferences = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const { tenantId, userId: currentUserId } = getScope(req);
    if (!tenantId) return sendError(res, 403, "Tenant context required.", requestId);

    const targetUserId = req.params.userId || currentUserId;
    const preferences = await CommunicationPreferenceService.getUserPreferences({
      tenantId,
      userId: targetUserId
    });

    return sendSuccess(res, 200, "User communication preferences retrieved.", preferences, requestId);
  } catch (err) {
    return sendError(res, statusFromError(err), err.message, requestId);
  }
};

export const updateUserPreferences = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const { tenantId, userId: currentUserId } = getScope(req);
    if (!tenantId) return sendError(res, 403, "Tenant context required.", requestId);

    const targetUserId = req.params.userId || currentUserId;
    const preferences = await CommunicationPreferenceService.updateUserPreferences({
      tenantId,
      userId: targetUserId,
      preferences: req.body,
      actorUserId: currentUserId
    });

    return sendSuccess(res, 200, "User communication preferences updated.", preferences, requestId);
  } catch (err) {
    return sendError(res, statusFromError(err), err.message, requestId);
  }
};

export const getConsentHistory = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const { tenantId, userId: currentUserId } = getScope(req);
    if (!tenantId) return sendError(res, 403, "Tenant context required.", requestId);

    const targetUserId = req.params.userId || currentUserId;
    const { page, limit } = req.query;
    const history = await CommunicationPreferenceService.getConsentHistory({
      tenantId,
      userId: targetUserId,
      page,
      limit
    });

    return sendSuccess(res, 200, "User consent history retrieved.", history, requestId);
  } catch (err) {
    return sendError(res, statusFromError(err), err.message, requestId);
  }
};

// 9. Email Platform APIs (Part 2)
export const sendEmailController = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const { tenantId, userId } = getScope(req);
    if (!tenantId) return sendError(res, 403, "Tenant context required.", requestId);

    const email = await EmailPlatformService.sendEmail({
      tenantId,
      ...req.body,
      userId
    });

    const statusCode = email.status === "Queued" ? 202 : 201;
    return sendSuccess(res, statusCode, "Email queued for delivery successfully.", email, requestId);
  } catch (err) {
    return sendError(res, statusFromError(err), err.message, requestId);
  }
};

export const getEmailTrackingStatusController = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const { tenantId } = getScope(req);
    if (!tenantId) return sendError(res, 403, "Tenant context required.", requestId);

    const trackingStatus = await EmailPlatformService.getEmailTrackingStatus({
      tenantId,
      trackingId: req.params.trackingId
    });

    return sendSuccess(res, 200, "Email tracking status retrieved successfully.", trackingStatus, requestId);
  } catch (err) {
    return sendError(res, statusFromError(err), err.message, requestId);
  }
};

// 10. Enterprise SMS Platform APIs (Part 3)
export const sendSmsController = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const { tenantId, userId } = getScope(req);
    if (!tenantId) return sendError(res, 403, "Tenant context required.", requestId);

    const sms = await SmsPlatformService.sendSms({
      tenantId,
      ...req.body,
      userId
    });

    const statusCode = sms.status === "Queued" ? 202 : 201;
    return sendSuccess(res, statusCode, "SMS processed for delivery successfully.", sms, requestId);
  } catch (err) {
    return sendError(res, statusFromError(err), err.message, requestId);
  }
};

export const getSmsTrackingStatusController = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const { tenantId } = getScope(req);
    if (!tenantId) return sendError(res, 403, "Tenant context required.", requestId);

    const trackingStatus = await SmsPlatformService.getSmsTrackingStatus({
      tenantId,
      trackingId: req.params.trackingId
    });

    return sendSuccess(res, 200, "SMS delivery status retrieved successfully.", trackingStatus, requestId);
  } catch (err) {
    return sendError(res, statusFromError(err), err.message, requestId);
  }
};

export const generateOtpController = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const { tenantId, userId } = getScope(req);
    if (!tenantId) return sendError(res, 403, "Tenant context required.", requestId);

    const otpResult = await SmsPlatformService.generateAndSendOtp({
      tenantId,
      ...req.body,
      userId
    });

    return sendSuccess(res, 201, "OTP generated and dispatched successfully.", otpResult, requestId);
  } catch (err) {
    return sendError(res, statusFromError(err), err.message, requestId);
  }
};

export const verifyOtpController = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const { tenantId } = getScope(req);
    if (!tenantId) return sendError(res, 403, "Tenant context required.", requestId);

    const otp = req.body.otp || req.body.otpCode;
    const verificationResult = await SmsPlatformService.verifyOtp({
      tenantId,
      phone: req.body.phone,
      otpCode: otp,
      purpose: req.body.purpose || "LoginOTP"
    });

    return sendSuccess(res, 200, "OTP verified successfully.", verificationResult, requestId);
  } catch (err) {
    return sendError(res, statusFromError(err), err.message, requestId);
  }
};

export const createBulkSmsCampaignController = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const { tenantId, userId } = getScope(req);
    if (!tenantId) return sendError(res, 403, "Tenant context required.", requestId);

    const campaign = await SmsPlatformService.createBulkCampaign({
      tenantId,
      ...req.body,
      userId
    });

    return sendSuccess(res, 201, "Bulk SMS campaign created successfully.", campaign, requestId);
  } catch (err) {
    return sendError(res, statusFromError(err), err.message, requestId);
  }
};

export const getBulkSmsCampaignController = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const { tenantId } = getScope(req);
    if (!tenantId) return sendError(res, 403, "Tenant context required.", requestId);

    const campaign = await SmsPlatformService.getCampaignDetails({
      tenantId,
      campaignId: req.params.campaignId
    });

    return sendSuccess(res, 200, "Bulk SMS campaign details retrieved.", campaign, requestId);
  } catch (err) {
    return sendError(res, statusFromError(err), err.message, requestId);
  }
};

export const updateBulkSmsCampaignStatusController = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const { tenantId } = getScope(req);
    if (!tenantId) return sendError(res, 403, "Tenant context required.", requestId);

    const updatedCampaign = await SmsPlatformService.updateCampaignStatus({
      tenantId,
      campaignId: req.params.campaignId,
      action: req.body.action
    });

    return sendSuccess(res, 200, `Bulk SMS campaign status updated to ${updatedCampaign.status}.`, updatedCampaign, requestId);
  } catch (err) {
    return sendError(res, statusFromError(err), err.message, requestId);
  }
};

export const retrySmsController = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const { tenantId, userId } = getScope(req);
    if (!tenantId) return sendError(res, 403, "Tenant context required.", requestId);

    const retryResult = await SmsPlatformService.retrySms({
      tenantId,
      trackingId: req.params.trackingId,
      userId
    });

    return sendSuccess(res, 200, "SMS retried successfully.", retryResult, requestId);
  } catch (err) {
    return sendError(res, statusFromError(err), err.message, requestId);
  }
};

// 11. Enterprise WhatsApp Platform APIs (Part 4)
export const sendWhatsAppController = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const { tenantId, userId } = getScope(req);
    if (!tenantId) return sendError(res, 403, "Tenant context required.", requestId);

    const result = await WhatsAppPlatformService.sendWhatsApp({
      tenantId,
      ...req.body,
      userId
    });

    const statusCode = result.status === "Queued" ? 202 : 201;
    return sendSuccess(res, statusCode, "WhatsApp message processed for delivery successfully.", result, requestId);
  } catch (err) {
    return sendError(res, statusFromError(err), err.message, requestId);
  }
};

export const getWhatsAppTrackingStatusController = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const { tenantId } = getScope(req);
    if (!tenantId) return sendError(res, 403, "Tenant context required.", requestId);

    const trackingStatus = await WhatsAppPlatformService.getWhatsAppTrackingStatus({
      tenantId,
      trackingId: req.params.trackingId
    });

    return sendSuccess(res, 200, "WhatsApp delivery status retrieved successfully.", trackingStatus, requestId);
  } catch (err) {
    return sendError(res, statusFromError(err), err.message, requestId);
  }
};

export const getWhatsAppConversationWindowController = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const { tenantId } = getScope(req);
    if (!tenantId) return sendError(res, 403, "Tenant context required.", requestId);

    const phone = req.params.phone;
    const [conversation, isOpen] = await Promise.all([
      WhatsAppConversationService.getConversationWindow({ tenantId, phone }),
      WhatsAppConversationService.isWindowOpen({ tenantId, phone })
    ]);

    return sendSuccess(res, 200, "WhatsApp conversation window status retrieved.", { phone, isOpen, conversation }, requestId);
  } catch (err) {
    return sendError(res, statusFromError(err), err.message, requestId);
  }
};

