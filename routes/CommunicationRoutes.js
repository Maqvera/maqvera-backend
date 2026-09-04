import express from "express";
import rateLimit from "express-rate-limit";
import authenticateAccessToken from "../middleware/authenticateAccessToken.js";
import validate, { communicationSchemas } from "../middleware/validateRequest.js";
import {
  requestCommunication,
  listMessages,
  getMessageById,
  retryMessage,
  cancelMessage,
  archiveMessage,
  restoreMessage,
  purgeMessage,
  applyMessageLegalHold,
  removeMessageLegalHold,
  getMessageLegalHoldStatus,
  getCommunicationAnalytics,
  refreshCommunicationAnalytics,
  createTemplate,
  listTemplates,
  getTemplateById,
  updateTemplate,
  listTemplateVersions,
  listTemplateLocales,
  submitTemplateForReview,
  approveTemplate,
  rejectTemplate,
  rollbackTemplate,
  getUserPreferences,
  updateUserPreferences,
  getConsentHistory,
  sendEmailController,
  getEmailTrackingStatusController,
  sendSmsController,
  getSmsTrackingStatusController,
  generateOtpController,
  verifyOtpController,
  createBulkSmsCampaignController,
  getBulkSmsCampaignController,
  updateBulkSmsCampaignStatusController,
  retrySmsController,
  sendWhatsAppController,
  getWhatsAppTrackingStatusController,
  getWhatsAppConversationWindowController
} from "../controllers/CommunicationPlatformController.js";

const router = express.Router();

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: { status: 429, message: "Too many requests to Communication Platform APIs." }
});

router.use(authenticateAccessToken);

// Message Delivery & Routing
router.post("/send", limiter, validate(communicationSchemas.requestCommunication), requestCommunication);
router.get("/messages", limiter, listMessages);
router.get("/messages/:messageId", limiter, getMessageById);
router.post("/messages/:messageId/retry", limiter, retryMessage);
router.post("/messages/:messageId/cancel", limiter, cancelMessage);

// Retention & Legal Hold (Part 15)
router.post("/messages/:messageId/archive", limiter, validate(communicationSchemas.archiveMessage), archiveMessage);
router.post("/messages/:messageId/restore", limiter, restoreMessage);
router.post("/messages/:messageId/purge", limiter, validate(communicationSchemas.purgeMessage), purgeMessage);
router.post("/messages/:messageId/legal-hold", limiter, validate(communicationSchemas.applyLegalHold), applyMessageLegalHold);
router.delete("/messages/:messageId/legal-hold", limiter, validate(communicationSchemas.removeLegalHold), removeMessageLegalHold);
router.get("/messages/:messageId/legal-hold", limiter, getMessageLegalHoldStatus);
router.get("/analytics", limiter, getCommunicationAnalytics);
router.post("/analytics/refresh", limiter, refreshCommunicationAnalytics);

// Communication Templates
router.post("/templates", limiter, validate(communicationSchemas.createTemplate), createTemplate);
router.get("/templates", limiter, listTemplates);
router.get("/templates/:templateId", limiter, getTemplateById);
router.patch("/templates/:templateId", limiter, validate(communicationSchemas.updateTemplate), updateTemplate);
router.get("/templates/:templateId/versions", limiter, listTemplateVersions);
router.get("/templates/:templateId/locales", limiter, listTemplateLocales);
router.post("/templates/:templateId/submit", limiter, validate(communicationSchemas.templateLocaleAction), submitTemplateForReview);
router.post("/templates/:templateId/approve", limiter, validate(communicationSchemas.templateLocaleAction), approveTemplate);
router.post("/templates/:templateId/reject", limiter, validate(communicationSchemas.rejectTemplate), rejectTemplate);
router.post("/templates/:templateId/rollback", limiter, validate(communicationSchemas.rollbackTemplate), rollbackTemplate);

// Communication Preferences
router.get("/preferences", limiter, getUserPreferences);
router.get("/preferences/:userId", limiter, getUserPreferences);
router.patch("/preferences", limiter, validate(communicationSchemas.updateUserPreferences), updateUserPreferences);
router.patch("/preferences/:userId", limiter, validate(communicationSchemas.updateUserPreferences), updateUserPreferences);
router.get("/preferences/:userId/consent-history", limiter, getConsentHistory);
router.get("/consent-history", limiter, getConsentHistory);

// Enterprise Email Platform APIs (Part 2)
router.post("/emails", limiter, validate(communicationSchemas.sendEmail), sendEmailController);
router.get("/emails/:trackingId", limiter, getEmailTrackingStatusController);

// Enterprise SMS Platform APIs (Part 3)
// Direct SMS dispatch (supports POST /api/v1/sms and POST /api/v1/communication/sms)
router.post("/sms", limiter, validate(communicationSchemas.sendSms), sendSmsController);
router.post("/", limiter, validate(communicationSchemas.sendSms), sendSmsController);

// OTP Engine Endpoints
router.post("/sms/otp/generate", limiter, validate(communicationSchemas.generateOtp), generateOtpController);
router.post("/otp/generate", limiter, validate(communicationSchemas.generateOtp), generateOtpController);
router.post("/sms/otp/verify", limiter, validate(communicationSchemas.verifyOtp), verifyOtpController);
router.post("/otp/verify", limiter, validate(communicationSchemas.verifyOtp), verifyOtpController);

// Bulk SMS Campaigns
router.post("/sms/campaigns", limiter, validate(communicationSchemas.createBulkCampaign), createBulkSmsCampaignController);
router.post("/campaigns", limiter, validate(communicationSchemas.createBulkCampaign), createBulkSmsCampaignController);
router.get("/sms/campaigns/:campaignId", limiter, getBulkSmsCampaignController);
router.get("/campaigns/:campaignId", limiter, getBulkSmsCampaignController);
router.patch("/sms/campaigns/:campaignId/status", limiter, validate(communicationSchemas.updateCampaignStatus), updateBulkSmsCampaignStatusController);
router.patch("/campaigns/:campaignId/status", limiter, validate(communicationSchemas.updateCampaignStatus), updateBulkSmsCampaignStatusController);

// SMS Tracking & Retry (supports GET /api/v1/sms/:trackingId and GET /api/v1/communication/sms/:trackingId)
router.get("/sms/:trackingId", limiter, getSmsTrackingStatusController);
router.post("/sms/:trackingId/retry", limiter, retrySmsController);
router.get("/:trackingId", limiter, getSmsTrackingStatusController);
router.post("/:trackingId/retry", limiter, retrySmsController);

// Enterprise WhatsApp Platform APIs (Part 4)
router.post("/whatsapp", limiter, validate(communicationSchemas.sendWhatsApp), sendWhatsAppController);
router.get("/whatsapp/:trackingId", limiter, getWhatsAppTrackingStatusController);
router.get("/whatsapp/conversations/:phone/window", limiter, getWhatsAppConversationWindowController);

export default router;
