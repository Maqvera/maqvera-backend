import test from "node:test";
import assert from "node:assert/strict";
import SmsPlatformService from "../services/SmsPlatformService.js";
import CommunicationPreferenceService from "../services/CommunicationPreferenceService.js";
import CommunicationMessageModel from "../models/CommunicationMessageModel.js";
import SmsOtpModel from "../models/SmsOtpModel.js";
import SmsCampaignModel from "../models/SmsCampaignModel.js";
import { validatePhoneNumber, formatPhoneNumber, detectEncodingAndSegments, generateSecureOtpCode } from "../utils/smsHelper.js";

const tenantId = "TENANT-TEST-SMS-001";
const userId = "USER-TEST-100";

test("SMS Helper — phone validation & format", () => {
  assert.equal(validatePhoneNumber("+923001234567"), true);
  assert.equal(validatePhoneNumber("+14155552671"), true);
  assert.equal(validatePhoneNumber("invalid-phone"), false);

  assert.equal(formatPhoneNumber("923001234567"), "+923001234567");
  assert.equal(formatPhoneNumber("+923001234567"), "+923001234567");
});

test("SMS Helper — GSM-7 encoding detection", () => {
  const shortText = "Your verification code is 123456";
  const result = detectEncodingAndSegments(shortText);

  assert.equal(result.encoding, "GSM-7");
  assert.equal(result.isUnicode, false);
  assert.equal(result.segmentCount, 1);
});

test("SMS Helper — UCS-2 Unicode encoding detection (Urdu/Arabic/Chinese)", () => {
  const urduText = "آپ کا تصدیقی کوڈ 482913 ہے۔";
  const result = detectEncodingAndSegments(urduText);

  assert.equal(result.encoding, "UCS-2");
  assert.equal(result.isUnicode, true);
  assert.equal(result.segmentCount, 1);
});

test("SMS Helper — generate secure numeric OTP", () => {
  const otp = generateSecureOtpCode(6);
  assert.equal(typeof otp, "string");
  assert.equal(otp.length, 6);
  assert.equal(/^\d{6}$/.test(otp), true);
});

test("SmsPlatformService.sendSms — queue and send SMS with priority & tracking ID", async () => {
  const origSave = CommunicationMessageModel.prototype.save;
  const origFindOne = CommunicationMessageModel.findOne;
  const origPref = CommunicationPreferenceService.canSendToUser;
  try {
    CommunicationMessageModel.prototype.save = async function() { return this; };
    CommunicationMessageModel.findOne = async () => null;
    CommunicationPreferenceService.canSendToUser = async () => ({ allowed: true });

    const result = await SmsPlatformService.sendSms({
      tenantId,
      phone: "+923001234567",
      type: "Invoice",
      message: "Your invoice INV-1001 is ready.",
      userId
    });

    assert.ok(result.trackingId);
    assert.equal(result.trackingId.startsWith("SMS-"), true);
    assert.equal(result.phone, "+923001234567");
    assert.equal(result.smsType, "Invoice");
    assert.equal(result.priority, "High");
    assert.ok(["Delivered", "Queued", "Processing"].includes(result.status));
  } finally {
    CommunicationMessageModel.prototype.save = origSave;
    CommunicationMessageModel.findOne = origFindOne;
    CommunicationPreferenceService.canSendToUser = origPref;
  }
});

test("SmsPlatformService.sendSms — reject invalid phone number", async () => {
  await assert.rejects(
    async () => {
      await SmsPlatformService.sendSms({
        tenantId,
        phone: "invalid",
        message: "Hello"
      });
    },
    { message: /Invalid phone number format/ }
  );
});

test("SmsPlatformService.getSmsTrackingStatus — fetch delivery status", async () => {
  const origFindOne = CommunicationMessageModel.findOne;
  try {
    const fakeSms = {
      tenantId,
      trackingId: "SMS-TRACK-999",
      messageId: "SMS-TRACK-999",
      phone: "+923001234567",
      smsType: "OTP",
      status: "Delivered",
      provider: "Twilio",
      encoding: "GSM-7",
      segmentCount: 1,
      createdAt: new Date(),
      deliveredAt: new Date(),
      errorDetails: null,
      retryCount: 0
    };

    CommunicationMessageModel.findOne = () => ({
      lean: async () => fakeSms
    });

    const trackingStatus = await SmsPlatformService.getSmsTrackingStatus({
      tenantId,
      trackingId: "SMS-TRACK-999"
    });

    assert.equal(trackingStatus.trackingId, "SMS-TRACK-999");
    assert.equal(trackingStatus.phone, "+923001234567");
    assert.equal(trackingStatus.status, "Delivered");
    assert.equal(trackingStatus.provider, "Twilio");
  } finally {
    CommunicationMessageModel.findOne = origFindOne;
  }
});

test("SmsPlatformService — OTP Engine generate & verify flow", async () => {
  const origCount = SmsOtpModel.countDocuments;
  const origUpdateMany = SmsOtpModel.updateMany;
  const origOtpSave = SmsOtpModel.prototype.save;
  const origMsgSave = CommunicationMessageModel.prototype.save;
  const origFindOne = SmsOtpModel.findOne;
  const origPref = CommunicationPreferenceService.canSendToUser;

  try {
    SmsOtpModel.countDocuments = async () => 0;
    SmsOtpModel.updateMany = async () => {};
    SmsOtpModel.prototype.save = async function() { return this; };
    CommunicationMessageModel.prototype.save = async function() { return this; };
    CommunicationPreferenceService.canSendToUser = async () => ({ allowed: true });

    const otpRes = await SmsPlatformService.generateAndSendOtp({
      tenantId,
      phone: "+923001234567",
      purpose: "LoginOTP",
      userId
    });

    assert.ok(otpRes.otpId);
    assert.equal(otpRes.otpId.startsWith("OTP-"), true);
    assert.equal(otpRes.phone, "+923001234567");
    assert.ok(otpRes.expiresAt instanceof Date);

    // Test OTP verify
    const fakeOtpRecord = {
      tenantId,
      otpId: "OTP-TEST-123",
      phone: "+923001234567",
      otpCode: "482913",
      purpose: "LoginOTP",
      status: "Active",
      attempts: 0,
      maxAttempts: 3,
      expiresAt: new Date(Date.now() + 5 * 60 * 1000),
      save: async function() { return this; }
    };

    SmsOtpModel.findOne = async () => fakeOtpRecord;

    const verifyRes = await SmsPlatformService.verifyOtp({
      tenantId,
      phone: "+923001234567",
      otpCode: "482913",
      purpose: "LoginOTP"
    });

    assert.equal(verifyRes.verified, true);
    assert.equal(fakeOtpRecord.status, "Verified");
  } finally {
    SmsOtpModel.countDocuments = origCount;
    SmsOtpModel.updateMany = origUpdateMany;
    SmsOtpModel.prototype.save = origOtpSave;
    CommunicationMessageModel.prototype.save = origMsgSave;
    SmsOtpModel.findOne = origFindOne;
    CommunicationPreferenceService.canSendToUser = origPref;
  }
});

test("SmsPlatformService — Bulk SMS campaign creation", async () => {
  const origCampSave = SmsCampaignModel.prototype.save;
  const origProcess = SmsPlatformService._processCampaignBatch;
  try {
    SmsCampaignModel.prototype.save = async function() { return this; };
    SmsPlatformService._processCampaignBatch = async () => {};

    const campaign = await SmsPlatformService.createBulkCampaign({
      tenantId,
      name: "Summer Promotion",
      smsType: "Marketing",
      messageText: "Special 20% discount on flight bookings!",
      recipients: ["+923001234567", "+923007654321"],
      userId
    });

    assert.ok(campaign.campaignId);
    assert.equal(campaign.name, "Summer Promotion");
    assert.equal(campaign.totalRecipients, 2);
    assert.equal(campaign.status, "Processing");
  } finally {
    SmsCampaignModel.prototype.save = origCampSave;
    SmsPlatformService._processCampaignBatch = origProcess;
  }
});
