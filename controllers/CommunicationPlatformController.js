import CommunicationPlatformService from "../services/CommunicationPlatformService.js";
import CommunicationTemplateService from "../services/CommunicationTemplateService.js";
import CommunicationPreferenceService from "../services/CommunicationPreferenceService.js";
import EmailPlatformService from "../services/EmailPlatformService.js";
import SmsPlatformService from "../services/SmsPlatformService.js";
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

    const { channel, status, page, limit } = req.query;
    const result = await CommunicationTemplateService.listTemplates({
      tenantId,
      channel,
      status,
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
      templateId: req.params.templateId
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

    const template = await CommunicationTemplateService.updateTemplate({
      tenantId,
      templateId: req.params.templateId,
      updates: req.body,
      userId
    });

    return sendSuccess(res, 200, "Communication template updated successfully.", template, requestId);
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
      preferences: req.body
    });

    return sendSuccess(res, 200, "User communication preferences updated.", preferences, requestId);
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

