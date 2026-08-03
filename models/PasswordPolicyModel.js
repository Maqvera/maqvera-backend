import mongoose from "mongoose";

const PasswordPolicySchema = new mongoose.Schema({
  tenantId: {
    type: String,
    default: "default",
    unique: true,
    index: true,
  },
  minLength: {
    type: Number,
    default: 6,
    min: 4,
    max: 128,
  },
  maxLength: {
    type: Number,
    default: 128,
    min: 8,
    max: 256,
  },
  requireUppercase: {
    type: Boolean,
    default: false,
  },
  requireLowercase: {
    type: Boolean,
    default: false,
  },
  requireNumbers: {
    type: Boolean,
    default: false,
  },
  requireSpecialChars: {
    type: Boolean,
    default: false,
  },
  historyCount: {
    type: Number,
    default: 0,
    min: 0,
    max: 50,
    description: "Number of previous passwords to prevent reuse (0 = disabled)",
  },
  expiryDays: {
    type: Number,
    default: 0,
    min: 0,
    max: 365,
    description: "Days after which password expires (0 = never)",
  },
  maxFailedAttempts: {
    type: Number,
    default: 5,
    min: 1,
    max: 100,
  },
  lockoutMinutes: {
    type: Number,
    default: 15,
    min: 1,
    max: 1440,
  },
  isActive: {
    type: Boolean,
    default: true,
  },
}, { timestamps: true });

const PasswordPolicyModel = mongoose.model("password_policy", PasswordPolicySchema);
export default PasswordPolicyModel;
