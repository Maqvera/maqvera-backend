import mongoose from "mongoose";

/**
 * Enterprise SMS Platform — OTP Engine Record Schema
 * Handles expiration, one-time verification, max attempt tracking, resend limits, and fraud protection.
 * Tenant-scoped only — no branchId per Master Architecture rules.
 */
const SmsOtpSchema = new mongoose.Schema({
  tenantId: {
    type: String,
    required: true,
    index: true
  },
  otpId: {
    type: String,
    required: true,
    unique: true,
    index: true
  },
  phone: {
    type: String,
    required: true,
    index: true
  },
  otpCode: {
    type: String,
    required: true
  },
  purpose: {
    type: String,
    default: "Authentication",
    index: true
  },
  trackingId: {
    type: String,
    default: null,
    index: true
  },
  status: {
    type: String,
    enum: ["Active", "Verified", "Expired", "MaxAttemptsReached"],
    default: "Active",
    index: true
  },
  attempts: {
    type: Number,
    default: 0
  },
  maxAttempts: {
    type: Number,
    default: 3
  },
  expiresAt: {
    type: Date,
    required: true
  },
  verifiedAt: {
    type: Date,
    default: null
  },
  createdBy: {
    type: String,
    default: null
  }
}, { timestamps: true });

SmsOtpSchema.index({ tenantId: 1, phone: 1, status: 1 });
SmsOtpSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 86400 }); // TTL index to auto-clean old OTP records after 24h

SmsOtpSchema.set("toJSON", {
  transform: (_, ret) => {
    delete ret.__v;
    delete ret.otpCode; // Never leak raw/hashed OTP code in JSON responses
    return ret;
  }
});

const SmsOtpModel = mongoose.model("sms_otp", SmsOtpSchema);

export default SmsOtpModel;
