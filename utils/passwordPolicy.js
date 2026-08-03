import PasswordPolicyModel from "../models/PasswordPolicyModel.js";
import PasswordHistoryModel from "../models/PasswordHistoryModel.js";
import { getAuthConfig } from "./authConfig.js";

const envConfig = getAuthConfig();

const DEFAULT_POLICY = {
  minLength: envConfig.passwordMinLength,
  maxLength: 128,
  requireUppercase: envConfig.passwordRequireUppercase,
  requireLowercase: envConfig.passwordRequireLowercase,
  requireNumbers: envConfig.passwordRequireNumber,
  requireSpecialChars: envConfig.passwordRequireSpecial,
  historyCount: 0,
  expiryDays: 0,
};

export const getPasswordPolicy = async (tenantId) => {
  try {
    const policy = await PasswordPolicyModel.findOne({ tenantId: tenantId || "default", isActive: true }).lean();
    if (policy) {
      return {
        ...DEFAULT_POLICY,
        ...policy,
        minLength: policy.minLength || DEFAULT_POLICY.minLength,
        maxLength: policy.maxLength || DEFAULT_POLICY.maxLength,
        requireUppercase: policy.requireUppercase ?? DEFAULT_POLICY.requireUppercase,
        requireLowercase: policy.requireLowercase ?? DEFAULT_POLICY.requireLowercase,
        requireNumbers: policy.requireNumbers ?? DEFAULT_POLICY.requireNumbers,
        requireSpecialChars: policy.requireSpecialChars ?? DEFAULT_POLICY.requireSpecialChars,
      };
    }
    return DEFAULT_POLICY;
  } catch {
    return DEFAULT_POLICY;
  }
};

export const validatePassword = async (password, tenantId, userId) => {
  const policy = await getPasswordPolicy(tenantId);
  const errors = [];

  if (password.length < policy.minLength) {
    errors.push(`Password must be at least ${policy.minLength} characters`);
  }
  if (password.length > policy.maxLength) {
    errors.push(`Password must be at most ${policy.maxLength} characters`);
  }
  if (policy.requireUppercase && !/[A-Z]/.test(password)) {
    errors.push("Password must contain at least one uppercase letter");
  }
  if (policy.requireLowercase && !/[a-z]/.test(password)) {
    errors.push("Password must contain at least one lowercase letter");
  }
  if (policy.requireNumbers && !/\d/.test(password)) {
    errors.push("Password must contain at least one number");
  }
  if (policy.requireSpecialChars && !/[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?]/.test(password)) {
    errors.push("Password must contain at least one special character");
  }

  if (policy.historyCount > 0 && userId) {
    const recentPasswords = await PasswordHistoryModel.find({ userId })
      .sort({ changedAt: -1 })
      .limit(policy.historyCount)
      .lean();
    for (const entry of recentPasswords) {
      const bcrypt = await import("bcryptjs");
      const match = await bcrypt.default.compare(password, entry.passwordHash);
      if (match) {
        errors.push(`Cannot reuse a recent password. Choose a password different from your last ${policy.historyCount} passwords.`);
        break;
      }
    }
  }

  return { valid: errors.length === 0, errors, policy };
};

export const validatePasswordPolicy = (password) => {
  const authConfig = getAuthConfig();
  const errors = [];
  const minLength = authConfig.passwordMinLength;
  const requireUppercase = authConfig.passwordRequireUppercase;
  const requireLowercase = authConfig.passwordRequireLowercase;
  const requireNumber = authConfig.passwordRequireNumber;
  const requireSpecial = authConfig.passwordRequireSpecial;

  if (!password || password.length < minLength) {
    errors.push(`Password must be at least ${minLength} characters long.`);
  }
  if (requireUppercase && !/[A-Z]/.test(password || "")) {
    errors.push("Password must include at least one uppercase letter.");
  }
  if (requireLowercase && !/[a-z]/.test(password || "")) {
    errors.push("Password must include at least one lowercase letter.");
  }
  if (requireNumber && !/\d/.test(password || "")) {
    errors.push("Password must include at least one number.");
  }
  if (requireSpecial && !/[^A-Za-z0-9]/.test(password || "")) {
    errors.push("Password must include at least one special character.");
  }

  return { valid: errors.length === 0, errors };
};

export const recordPasswordHistory = async (userId, passwordHash, reason, requestId) => {
  try {
    await PasswordHistoryModel.create({ userId, passwordHash, reason, requestId });
  } catch (err) {
    console.error("Failed to record password history:", err.message);
  }
};
