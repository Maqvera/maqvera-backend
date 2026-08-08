import UserModel from "../models/Usermodel.js";
import UserPreferenceModel from "../models/UserPreferenceModel.js";
import bcrypt from "bcryptjs";
import crypto from "crypto";
import jwt from "jsonwebtoken";
import { v4 as uuidv4 } from "uuid";
import SessionModel from "../models/Sessionmodel.js";
import AuditLogModel from "../models/AuditLogmodel.js";
import EmailVerificationTokenModel from "../models/EmailVerificationTokenmodel.js";
import PasswordResetTokenModel from "../models/PasswordResetTokenmodel.js";
import TenantModel from "../models/Tenantmodel.js";
import BranchModel from "../models/Branchmodel.js";
import RoleModel from "../models/Rolemodel.js";
import LoginHistoryModel from "../models/LoginHistoryModel.js";
import TrustedDeviceModel from "../models/TrustedDeviceModel.js";
import PasswordHistoryModel from "../models/PasswordHistoryModel.js";
import { createAccessToken, createRefreshToken, getRefreshTokenExpiryDate, hashToken, getAccessTokenExpiresInSeconds } from "../utils/authTokens.js";
import { publishEvent } from "../utils/eventBus.js";
import { sendError, sendSuccess } from "../utils/apiResponse.js";
import { authenticator } from "otplib";
import { getAuthConfig } from "../utils/authConfig.js";
import { ensureAdministratorRole } from "../utils/authDomainDefaults.js";
import { validatePassword, recordPasswordHistory, getPasswordPolicy } from "../utils/passwordPolicy.js";
import CacheManager from "../utils/cacheManager.js";
import { parseUserAgent } from "../utils/userAgentParser.js";
import { resolveGeoLocation } from "../utils/geoLocation.js";
import logger from "../utils/logger.js";

const config = getAuthConfig();

const getTransporter = () => {
  const nodemailer = {};
  try {
    return nodemailer;
  } catch {
    return null;
  }
};

let transporter = null;
try {
  const mod = await import("nodemailer");
  transporter = mod.default.createTransport({
    host: config.smtpHost,
    port: config.smtpPort,
    secure: config.smtpSecure,
    auth: {
      user: config.smtpUser,
      pass: config.smtpPass,
    },
  });
  transporter.verify((err) => {
    if (err) logger.warn("SMTP transport not available", { error: err.message });
    else logger.info("SMTP transport ready");
  });
} catch (err) {
  logger.warn("Nodemailer not available, emails disabled", { error: err.message });
}

const hashResetToken = (token) => crypto.createHash("sha256").update(token).digest("hex");
const hashVerificationToken = (token) => crypto.createHash("sha256").update(token).digest("hex");
const hashCode = (code) => crypto.createHash("sha256").update(String(code)).digest("hex");

const getMfaEncryptionKey = () => {
  return crypto.createHash("sha256").update(config.mfaEncryptionKey).digest();
};

const encryptMfaValue = (value) => {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", getMfaEncryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return {
    encrypted: encrypted.toString("base64"),
    iv: iv.toString("base64"),
    authTag: authTag.toString("base64"),
  };
};

const decryptMfaValue = (encrypted, iv, authTag) => {
  if (!encrypted || !iv || !authTag) return null;
  try {
    const decipher = crypto.createDecipheriv("aes-256-gcm", getMfaEncryptionKey(), Buffer.from(iv, "base64"));
    decipher.setAuthTag(Buffer.from(authTag, "base64"));
    const result = Buffer.concat([decipher.update(Buffer.from(encrypted, "base64")), decipher.final()]);
    return result.toString("utf8");
  } catch {
    return null;
  }
};

const generateRecoveryCodes = () => {
  return Array.from({ length: 10 }, () =>
    crypto.randomBytes(6).toString("base64").replace(/[^A-Z0-9]/gi, "").slice(0, 10).toUpperCase()
  );
};

const sendEmail = async ({ to, subject, html }) => {
  if (!transporter) {
    logger.warn("Email not sent: transporter unavailable", { to, subject });
    return;
  }
  try {
    await transporter.sendMail({
      from: config.emailFrom,
      to,
      subject: `${subject} - ${config.appName}`,
      html,
    });
  } catch (err) {
    logger.error("Email send failed", { error: err.message, to, subject });
  }
};

const queueEmail = (payload) => {
  if (config.emailSendAsync) {
    setImmediate(() => {
      sendEmail(payload).catch((err) => {
        logger.error("Queued email dispatch failed", { error: err.message, payload: payload.subject });
      });
    });
    return;
  }
  return sendEmail(payload);
};

const buildEmailTemplate = (title, bodyLines, ctaLink, ctaText) => {
  const lines = bodyLines.map((line) => `<p style="margin:0 0 10px;color:#555;font-size:15px;line-height:1.6;">${line}</p>`).join("");
  const appLogo = process.env.APP_LOGO_URL || "";
  const logoHtml = appLogo ? `<img src="${appLogo}" alt="${config.appName}" style="max-width:150px;margin-bottom:20px;">` : `<h1 style="color:#1a73e8;margin:0 0 10px;font-size:22px;">${config.appName}</h1>`;
  const ctaHtml = ctaLink ? `<div style="text-align:center;margin:25px 0;"><a href="${ctaLink}" style="display:inline-block;background:#1a73e8;color:#fff;padding:12px 30px;border-radius:6px;text-decoration:none;font-weight:bold;font-size:15px;">${ctaText || "Proceed"}</a></div>` : "";
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>${config.appName}</title></head><body style="margin:0;padding:0;background:#f4f4f4;font-family:Arial,Helvetica,sans-serif;"><div style="max-width:600px;margin:30px auto;background:#fff;border-radius:8px;padding:30px;box-shadow:0 2px 8px rgba(0,0,0,0.08);"><div style="text-align:center;margin-bottom:20px;">${logoHtml}</div><div>${lines}</div>${ctaHtml}<hr style="border:none;border-top:1px solid #eee;margin:25px 0;"><p style="font-size:12px;color:#888;text-align:center;">&copy; ${new Date().getFullYear()} ${config.appName}. All rights reserved.</p></div></body></html>`;
};

const sendMfaEmailCode = async ({ toEmail, username, code, purpose }) => {
  const purposeText = purpose === "setup" ? "multi-factor authentication setup" : purpose === "disable" ? "multi-factor authentication removal" : "login";
  await queueEmail({
    to: toEmail,
    subject: `Your ${purpose} code`,
    html: buildEmailTemplate(
      "Authentication Code",
      [`Hi ${username},`, `Your ${purposeText} code is:`, `<h2 style="color:#1a73e8;text-align:center;font-size:32px;letter-spacing:4px;background:#f0f4ff;padding:15px;border-radius:6px;">${code}</h2>`, "This code is valid for 10 minutes.", "If you didn't request this, please ignore this email."],
      null, null
    ),
  });
};

const verifyMfaPayload = async (user, code, recoveryCode) => {
  if (recoveryCode) {
    const recoveryHash = hashCode(recoveryCode);
    const entry = (user.mfaRecoveryCodes || []).find((e) => e.hash === recoveryHash && !e.usedAt);
    if (!entry) return { success: false, reason: "invalid_recovery_code" };
    entry.usedAt = new Date();
    await user.save();
    return { success: true, type: "recovery" };
  }
  if (user.mfaMethod === "totp") {
    const secret = decryptMfaValue(user.mfaSecretEncrypted, user.mfaSecretIv, user.mfaSecretAuthTag);
    if (!secret || !authenticator.check(code, secret)) return { success: false, reason: "invalid_totp_code" };
    return { success: true, type: "totp" };
  }
  if (user.mfaMethod === "email" || user.mfaMethod === "sms") {
    const challenge = user.mfaLoginChallenge;
    if (!challenge?.codeHash || !challenge.expiresAt) return { success: false, reason: "login_challenge_missing" };
    if (new Date(challenge.expiresAt) < new Date()) return { success: false, reason: "challenge_expired" };
    if (hashCode(code) !== challenge.codeHash) {
      challenge.attempts = (challenge.attempts || 0) + 1;
      await user.save();
      return { success: false, reason: "invalid_login_code" };
    }
    return { success: true, type: user.mfaMethod };
  }
  return { success: false, reason: "unsupported_mfa_method" };
};

export const getRequestMeta = (req) => ({
  requestId: req.requestId || uuidv4(),
  ipAddress: req.headers["x-forwarded-for"]?.toString().split(",")[0]?.trim() || req.ip || req.socket?.remoteAddress || null,
  deviceId: req.header("X-Device-ID") || null,
  userAgent: req.header("User-Agent") || null,
});

const createAudit = async ({ action, outcome, reason, user, email, sessionId, requestId, ipAddress, device, browser, metadata }) => {
  try {
    await AuditLogModel.create({
      action, outcome, reason,
      userId: user?._id || null,
      email: user?.email || email || null,
      tenantId: user?.tenantId || null,
      branchId: user?.branchId || null,
      sessionId: sessionId || null,
      requestId, ipAddress, device, browser,
      metadata: metadata || {},
    });
  } catch (err) {
    logger.error("Audit log creation failed", { error: err.message, action });
  }
};

// Every failed login attempt must be both audited and published as a domain
// event (Section 19 of the login contract: Failed Login -> LoginFailed).
const recordLoginFailure = async ({ reason, user = null, email = null, meta, metadata }) => {
  await createAudit({ action: "login", outcome: "failed", reason, user, email, requestId: meta.requestId, ipAddress: meta.ipAddress, device: meta.deviceId, browser: meta.userAgent, metadata });
  publishEvent("LoginFailed", {
    userId: user?._id ? user._id.toString() : null,
    email: user?.email || email || null,
    tenantId: user?.tenantId || null,
    reason,
    requestId: meta.requestId,
  });
};

const resolveDomainContext = async (user) => {
  const [tenant, branch, role] = await Promise.all([
    user.tenantId ? TenantModel.findOne({ tenantKey: user.tenantId, status: "active" }).lean() : null,
    user.branchId ? BranchModel.findOne({ branchKey: user.branchId, tenantKey: user.tenantId, status: "active" }).lean() : null,
    // Role.name is unique per tenant, not globally — must filter by the
    // user's own tenant, or this could resolve a different tenant's
    // same-named role (wrong permission set entirely).
    user.role && user.tenantId ? RoleModel.findOne({ tenantId: user.tenantId, name: user.role, status: "active" }).lean() : null,
  ]);
  return { tenant, branch, role, permissions: role?.permissions || [] };
};

// Signup must always land a new user in an explicit, caller-specified
// tenant — never in "whichever tenant happens to be oldest in the DB", which
// used to silently merge every company that ever signed up into one tenant.
// DEFAULT_TENANT_KEY is the one deliberate exception: an operator opting a
// genuinely single-tenant on-prem deployment into treating it as the
// implicit target — not a fallback that activates on its own.
const resolveSignupTenant = async (tenantKey) => {
  const key = tenantKey || process.env.DEFAULT_TENANT_KEY || null;
  if (!key) return null;
  return TenantModel.findOne({ tenantKey: key, status: "active" }).lean();
};

// Returns a clean, explicit preferences object — never the raw Mongo
// document (which would leak _id/__v/userId/timestamps to API responses).
const DEFAULT_PREFERENCES = { language: "en", timezone: "UTC", theme: "light", dateFormat: "YYYY-MM-DD", timeFormat: "24h", notifications: { email: true, sms: false, push: true }, dashboardLayout: null };

const loadUserPreferences = async (userId) => {
  let source = null;
  try {
    source = await UserPreferenceModel.findOne({ userId }).lean();
  } catch {
    source = null;
  }
  return {
    language: source?.language || DEFAULT_PREFERENCES.language,
    timezone: source?.timezone || DEFAULT_PREFERENCES.timezone,
    theme: source?.theme || DEFAULT_PREFERENCES.theme,
    dateFormat: source?.dateFormat || DEFAULT_PREFERENCES.dateFormat,
    timeFormat: source?.timeFormat || DEFAULT_PREFERENCES.timeFormat,
    notifications: source?.notifications || DEFAULT_PREFERENCES.notifications,
    dashboardLayout: source?.dashboardLayout ?? DEFAULT_PREFERENCES.dashboardLayout,
  };
};

const issueEmailVerificationToken = async ({ user, requestId, ipAddress, deviceId, userAgent }) => {
  await EmailVerificationTokenModel.updateMany({ userId: user._id, active: true }, { $set: { active: false } });
  const verificationToken = crypto.randomBytes(32).toString("hex");
  const tokenHash = hashVerificationToken(verificationToken);
  const expiresAt = new Date(Date.now() + config.emailVerificationTtlHours * 60 * 60 * 1000);
  await EmailVerificationTokenModel.create({ userId: user._id, email: user.email, tokenHash, expiresAt, active: true });
  const verificationUrl = `${config.frontendUrl}/verify-email?token=${verificationToken}`;
  await queueEmail({
    to: user.email,
    subject: "Verify Your Email",
    html: buildEmailTemplate("Verify Your Email", [`Hi ${user.username},`, "Thank you for creating an account. Please click the button below to verify your email address.", "This link expires in 24 hours."], verificationUrl, "Verify Email"),
  });
  await createAudit({ action: "email-send-verification", outcome: "success", user, requestId, ipAddress, device: deviceId, browser: userAgent, metadata: { verificationTokenCreated: true } });
  publishEvent("EmailVerificationRequested", { userId: user._id.toString(), requestId });
};

// Real signals only: unrecognized device, a country never seen on a prior
// successful login, and a burst of recent failures. No fixed/fake score.
const assessLoginRisk = async ({ user, status, country, deviceId }) => {
  let score = status === "failed" ? 30 : 0;
  if (user?._id) {
    if (deviceId) {
      const trustedDevice = await TrustedDeviceModel.exists({ userId: user._id, deviceId, isActive: true });
      if (!trustedDevice) score += 15;
    }
    if (country) {
      const seenCountry = await LoginHistoryModel.exists({ userId: user._id, status: "success", country });
      if (!seenCountry) score += 20;
    }
    const recentFailures = await LoginHistoryModel.countDocuments({
      userId: user._id, status: "failed", createdAt: { $gte: new Date(Date.now() - 30 * 60 * 1000) },
    });
    if (recentFailures >= 3) score += 25;
  }
  score = Math.min(score, 100);
  return { riskScore: score, isSuspicious: score >= 50 };
};

const recordLoginHistory = async ({ user, email, sessionId, action, status, failureReason, meta }) => {
  try {
    const { os, browser } = parseUserAgent(meta.userAgent);
    const { country, city } = resolveGeoLocation(meta.ipAddress);
    const { riskScore, isSuspicious } = await assessLoginRisk({ user, status, country, deviceId: meta.deviceId });
    await LoginHistoryModel.create({
      userId: user?._id || null,
      email: email || user?.email || null,
      tenantId: user?.tenantId || null,
      branchId: user?.branchId || null,
      sessionId: sessionId || null,
      action,
      status,
      failureReason: failureReason || null,
      ipAddress: meta.ipAddress || null,
      country,
      city,
      deviceId: meta.deviceId || null,
      browser,
      os,
      userAgent: meta.userAgent || null,
      riskScore,
      isSuspicious,
      requestId: meta.requestId || null,
    });
  } catch (err) {
    logger.error("Failed to record login history", { error: err.message });
  }
};

export const createSessionAndTokens = async (user, meta, rememberMe = false) => {
  const isRemembered = Boolean(rememberMe);
  const { os, browser, deviceType } = parseUserAgent(meta.userAgent);
  const { country, city } = resolveGeoLocation(meta.ipAddress);
  const session = await SessionModel.create({
    userId: user._id,
    email: user.email,
    tenantId: user.tenantId || null,
    branchId: user.branchId || null,
    refreshTokenHash: hashToken(uuidv4()),
    deviceId: meta.deviceId,
    userAgent: meta.userAgent,
    ipAddress: meta.ipAddress,
    browser,
    os,
    deviceType,
    country,
    city,
    status: "active",
    rememberMe: isRemembered,
    expiresAt: getRefreshTokenExpiryDate(isRemembered),
  });
  const accessToken = createAccessToken({
    email: user.email,
    id: user._id,
    sessionId: session._id,
    role: user.role,
    tenantId: user.tenantId,
    branchId: user.branchId,
  });
  const refreshToken = createRefreshToken({
    email: user.email,
    id: user._id,
    sessionId: session._id,
    tenantId: user.tenantId,
    branchId: user.branchId,
  }, isRemembered);
  session.refreshTokenHash = hashToken(refreshToken);
  await session.save();
  await UserModel.findByIdAndUpdate(user._id, { failedLoginAttempts: 0, lockUntil: null, lastLoginAt: new Date() });
  publishEvent("SessionCreated", {
    userId: user._id.toString(),
    sessionId: session._id.toString(),
    tenantId: user.tenantId || null,
    branchId: user.branchId || null,
    rememberMe: isRemembered,
    requestId: meta.requestId,
  });
  return { session, accessToken, refreshToken };
};

// ============================================================
//  ENDPOINTS
// ============================================================

export const Signup = async (Req, Res) => {
  try {
    const { username, email, password, tenantKey } = Req.body;
    const meta = getRequestMeta(Req);
    const existing = await UserModel.findOne({ email });
    if (existing) {
      return sendError(Res, 409, "User already exists.", meta.requestId);
    }
    const tenant = await resolveSignupTenant(tenantKey);
    if (!tenant) {
      return sendError(Res, 422, "A valid company identifier (tenantKey) is required to sign up. Registering a brand-new company? Use POST /auth/setup instead.", meta.requestId);
    }
    const branch = await BranchModel.findOne({ tenantKey: tenant.tenantKey, status: "active" }).sort({ createdAt: 1 }).lean();
    const { valid, errors } = await validatePassword(password, tenant.tenantKey);
    if (!valid) {
      return sendError(Res, 422, "Password does not meet policy requirements.", meta.requestId, { errors });
    }
    const hash = await bcrypt.hash(password, 10);
    const user = await UserModel.create({
      username, email, password: hash,
      tenantId: tenant.tenantKey,
      branchId: branch?.branchKey || null,
      role: "User",
    });
    await recordPasswordHistory(user._id, hash, "change", meta.requestId);
    await issueEmailVerificationToken({ user, requestId: meta.requestId, ipAddress: meta.ipAddress, deviceId: meta.deviceId, userAgent: meta.userAgent });
    return sendSuccess(Res, 201, "Signup successful. Please check your email for verification link.", {
      id: user._id, username: user.username, email: user.email, tenantId: tenant.tenantKey,
    }, meta.requestId);
  } catch (error) {
    logger.error("Signup error", { error: error.message });
    return sendError(Res, 500, "Something went wrong", Req.requestId || uuidv4());
  }
};

// New-company self-registration: creates a real tenant + its first branch +
// a shared "Administrator" role (see utils/authDomainDefaults.js) + the
// tenant's first admin user, in one call. This is the ONLY code path that
// creates a TenantModel document at runtime — every other write path in the
// app (Signup, AcceptUserInvitation) joins a tenant that already exists.
export const SetupTenant = async (Req, Res) => {
  const meta = getRequestMeta(Req);
  try {
    const { companyName, tenantKey, branchName, username, email, password } = Req.body;

    const existingTenant = await TenantModel.findOne({ tenantKey });
    if (existingTenant) {
      return sendError(Res, 409, "This company identifier is already in use.", meta.requestId);
    }
    const existingUser = await UserModel.findOne({ email });
    if (existingUser) {
      return sendError(Res, 409, "User already exists.", meta.requestId);
    }
    const { valid, errors } = await validatePassword(password, tenantKey);
    if (!valid) {
      return sendError(Res, 422, "Password does not meet policy requirements.", meta.requestId, { errors });
    }

    // No Mongoose session/transaction here — no write path in this codebase
    // uses one (standalone MongoDB is assumed, not a replica set). Instead:
    // create sequentially, and if a later step fails, compensate by deleting
    // whatever was already created rather than leaving an orphaned tenant.
    let tenant = null;
    let branch = null;
    try {
      tenant = await TenantModel.create({ tenantKey, name: companyName, status: "active" });
      branch = await BranchModel.create({ branchKey: "MAIN", tenantKey: tenant.tenantKey, name: branchName || "Head Office", status: "active" });
      const role = await ensureAdministratorRole(tenant.tenantKey);

      const hash = await bcrypt.hash(password, 10);
      const user = await UserModel.create({
        username, email, password: hash,
        tenantId: tenant.tenantKey,
        branchId: branch.branchKey,
        role: role.name,
      });
      await recordPasswordHistory(user._id, hash, "change", meta.requestId);
      await issueEmailVerificationToken({ user, requestId: meta.requestId, ipAddress: meta.ipAddress, deviceId: meta.deviceId, userAgent: meta.userAgent });

      await createAudit({ action: "tenant.setup", outcome: "success", user, requestId: meta.requestId, ipAddress: meta.ipAddress, device: meta.deviceId, browser: meta.userAgent, metadata: { tenantKey: tenant.tenantKey, branchKey: branch.branchKey } });
      publishEvent("TenantProvisioned", { tenantId: tenant.tenantKey, branchId: branch.branchKey, adminUserId: user._id.toString(), companyName: tenant.name, requestId: meta.requestId });

      return sendSuccess(Res, 201, "Company registered successfully. Please check your email for the verification link.", {
        id: user._id, username: user.username, email: user.email, tenantId: tenant.tenantKey, branchId: branch.branchKey,
      }, meta.requestId);
    } catch (innerError) {
      if (branch) await BranchModel.deleteOne({ _id: branch._id }).catch(() => {});
      if (tenant) await TenantModel.deleteOne({ _id: tenant._id }).catch(() => {});
      throw innerError;
    }
  } catch (error) {
    logger.error("SetupTenant error", { error: error.message });
    return sendError(Res, 500, "Something went wrong", meta.requestId);
  }
};

export const Login = async (Req, Res) => {
  try {
    const { email, password, rememberMe = false } = Req.body;
    const meta = getRequestMeta(Req);

    const user = await UserModel.findOne({ email });
    if (!user) {
      await recordLoginFailure({ reason: "invalid_credentials", email, meta });
      return sendError(Res, 401, "Invalid email or password.", meta.requestId);
    }

    if (user.status === "deleted" || user.isDeleted) {
      await recordLoginFailure({ reason: "deleted_account", user, meta });
      return sendError(Res, 403, "Account exists but cannot access the platform.", meta.requestId);
    }

    if (user.status === "suspended" || user.isSuspended) {
      await recordLoginFailure({ reason: "suspended_account", user, meta });
      return sendError(Res, 403, "Account exists but cannot access the platform.", meta.requestId);
    }

    if (user.lockUntil && new Date(user.lockUntil) > new Date()) {
      await recordLoginFailure({ reason: "account_locked", user, meta });
      return sendError(Res, 423, "Account temporarily locked.", meta.requestId);
    }

    const passwordValid = await bcrypt.compare(password, user.password);
    if (!passwordValid) {
      const attempts = (user.failedLoginAttempts || 0) + 1;
      const maxAttempts = config.maxLoginAttempts;
      const justLocked = attempts >= maxAttempts;
      const update = { failedLoginAttempts: attempts };
      if (justLocked) {
        update.lockUntil = new Date(Date.now() + config.loginLockoutMinutes * 60 * 1000);
      }
      await UserModel.findByIdAndUpdate(user._id, update);
      await recordLoginFailure({ reason: justLocked ? "account_locked" : "invalid_credentials", user, meta, metadata: { failedLoginAttempts: attempts } });
      await recordLoginHistory({ user, action: "login_failed", status: "failed", failureReason: justLocked ? "account_locked" : "invalid_credentials", meta });
      if (justLocked) {
        publishEvent("AccountLocked", { userId: user._id.toString(), email: user.email, tenantId: user.tenantId || null, lockUntil: update.lockUntil, requestId: meta.requestId });
        return sendError(Res, 423, "Account temporarily locked.", meta.requestId);
      }
      return sendError(Res, 401, "Invalid email or password.", meta.requestId);
    }

    const passwordPolicy = await getPasswordPolicy(user.tenantId);
    if (user.passwordChangedAt && passwordPolicy.expiryDays > 0) {
      const passwordExpiryMs = passwordPolicy.expiryDays * 24 * 60 * 60 * 1000;
      if (Date.now() - new Date(user.passwordChangedAt).getTime() > passwordExpiryMs) {
        await recordLoginFailure({ reason: "password_expired", user, meta });
        return sendError(Res, 403, "Password expired. Please reset your password.", meta.requestId);
      }
    }

    if (!(user.Isverifed || user.emailVerified)) {
      await recordLoginFailure({ reason: "email_not_verified", user, meta });
      return sendError(Res, 403, "Account exists but cannot access the platform.", meta.requestId);
    }

    if (user.status === "inactive") {
      await recordLoginFailure({ reason: "inactive_account", user, meta });
      return sendError(Res, 403, "Account exists but cannot access the platform.", meta.requestId);
    }

    const domain = await resolveDomainContext(user);

    if (user.role && !domain.role) {
      await recordLoginFailure({ reason: "role_disabled", user, meta });
      return sendError(Res, 403, "Account exists but cannot access the platform.", meta.requestId);
    }

    if (user.tenantId && !domain.tenant) {
      await recordLoginFailure({ reason: "tenant_disabled", user, meta });
      return sendError(Res, 403, "Account exists but cannot access the platform.", meta.requestId);
    }

    if (user.branchId && !domain.branch) {
      await recordLoginFailure({ reason: "branch_disabled", user, meta });
      return sendError(Res, 403, "Account exists but cannot access the platform.", meta.requestId);
    }

    if (config.strictDomainAuth && (!user.tenantId || !user.branchId || !user.role || !domain.tenant || !domain.branch || !domain.role)) {
      await recordLoginFailure({ reason: "domain_context_required", user, meta });
      return sendError(Res, 403, "Account exists but cannot access the platform.", meta.requestId);
    }

    if (user.mfaEnabled) {
      const mfaToken = jwt.sign({
        id: user._id, email: user.email, loginMfa: true,
        mfaMethod: user.mfaMethod, rememberMe: Boolean(rememberMe), requestId: meta.requestId,
      }, config.accessTokenSecret, { expiresIn: `${config.mfaTokenTtlMinutes}m` });
      if (user.mfaMethod === "email") {
        const mfaCode = Math.floor(100000 + Math.random() * 900000).toString();
        user.mfaLoginChallenge = {
          codeHash: hashCode(mfaCode),
          expiresAt: new Date(Date.now() + config.mfaCodeTtlMinutes * 60 * 1000),
          attempts: 0, method: "email",
        };
        await sendMfaEmailCode({ toEmail: user.email, username: user.username, code: mfaCode, purpose: "login" });
      } else {
        user.mfaLoginChallenge = { codeHash: null, expiresAt: new Date(Date.now() + config.mfaCodeTtlMinutes * 60 * 1000), attempts: 0, method: user.mfaMethod };
      }
      await user.save();
      await createAudit({ action: "login", outcome: "challenge", reason: "mfa_required", user, requestId: meta.requestId, ipAddress: meta.ipAddress, device: meta.deviceId, browser: meta.userAgent, metadata: { mfaMethod: user.mfaMethod } });
      return sendSuccess(Res, 200, "Multi-factor authentication required.", {
        mfaRequired: true, mfaMethod: user.mfaMethod, mfaToken, expiresIn: config.mfaTokenTtlMinutes * 60,
      }, meta.requestId);
    }

    const { session, accessToken, refreshToken } = await createSessionAndTokens(user, meta, rememberMe);

    await createAudit({ action: "login", outcome: "success", user, sessionId: session._id, requestId: meta.requestId, ipAddress: meta.ipAddress, device: meta.deviceId, browser: meta.userAgent, metadata: { status: "authenticated" } });
    await recordLoginHistory({ user, sessionId: session._id, action: "login", status: "success", meta });
    publishEvent("UserLoggedIn", { userId: user._id.toString(), sessionId: session._id.toString(), requestId: meta.requestId, tenantId: user.tenantId, branchId: user.branchId });

    return sendSuccess(Res, 200, "Login successful.", {
      accessToken,
      refreshToken,
      expiresIn: getAccessTokenExpiresInSeconds(),
      user: { id: user._id, fullName: user.username, email: user.email, role: user.role, tenantId: user.tenantId, branchId: user.branchId },
    }, meta.requestId);
  } catch (error) {
    logger.error("Login error", { error: error.message });
    return sendError(Res, 500, "Unexpected server failure.", Req.requestId || uuidv4());
  }
};

export const Logout = async (Req, Res) => {
  const meta = getRequestMeta(Req);
  try {
    const userId = Req.auth?.id;
    const sessionId = Req.auth?.sessionId;
    if (!userId || !sessionId) return sendError(Res, 401, "Invalid JWT", meta.requestId);

    const logoutFromAllDevices = Boolean(Req.body?.logoutFromAllDevices);
    const logoutSource = Req.header("X-Logout-Source") || "user_action";

    const session = await SessionModel.findOne({ _id: sessionId, userId });
    if (!session) return sendError(Res, 404, "Session not found", meta.requestId);

    // Server-side trust is revoked immediately and unconditionally (Rule 6),
    // independent of whatever account-status response we resolve below.
    let sessionsRevoked = 0;
    if (session.status !== "revoked") {
      session.status = "revoked";
      session.revokedAt = new Date();
      session.lastActivityAt = new Date();
      await session.save();
      sessionsRevoked = 1;
    }

    if (logoutFromAllDevices) {
      const bulkResult = await SessionModel.updateMany(
        { userId, status: "active" },
        { $set: { status: "revoked", revokedAt: new Date() } }
      );
      sessionsRevoked += bulkResult.modifiedCount || 0;
    }

    publishEvent("UserLoggedOut", { userId: String(userId), sessionId: String(sessionId), requestId: meta.requestId });
    if (logoutFromAllDevices) {
      publishEvent("AllSessionsRevoked", { userId: String(userId), count: sessionsRevoked, reason: "logout_all_devices", requestId: meta.requestId });
    }

    const user = await UserModel.findById(userId);
    const domain = user ? await resolveDomainContext(user) : null;
    const isAccountDisabled = !user || ["deleted", "suspended", "inactive"].includes(user.status) || user.isDeleted || user.isSuspended;
    const isTenantDisabled = Boolean(user?.tenantId) && !domain?.tenant;
    const isBranchDisabled = Boolean(user?.branchId) && !domain?.branch;
    const auditUser = user || { _id: userId, email: Req.auth?.email || session.email, tenantId: Req.auth?.tenantId || session.tenantId, branchId: Req.auth?.branchId || session.branchId };

    if (isAccountDisabled || isTenantDisabled || isBranchDisabled) {
      const reason = isTenantDisabled ? "tenant_disabled" : isBranchDisabled ? "branch_disabled" : "account_disabled";
      await createAudit({ action: "logout", outcome: "failed", reason, user: auditUser, sessionId: session._id, requestId: meta.requestId, ipAddress: meta.ipAddress, device: meta.deviceId, browser: meta.userAgent, metadata: { logoutFromAllDevices, logoutSource, sessionsRevoked } });
      return sendError(Res, 403, isTenantDisabled ? "Disabled tenant" : "Disabled account", meta.requestId);
    }

    await createAudit({ action: "logout", outcome: "success", user: auditUser, sessionId: session._id, requestId: meta.requestId, ipAddress: meta.ipAddress, device: meta.deviceId, browser: meta.userAgent, metadata: { logoutFromAllDevices, logoutSource, sessionsRevoked } });
    return sendSuccess(Res, 200, "Logout successful.", null, meta.requestId);
  } catch (error) {
    logger.error("Logout error", { error: error.message });
    return sendError(Res, 500, "Unexpected failure", meta.requestId);
  }
};

export const Refresh = async (Req, Res) => {
  const meta = getRequestMeta(Req);
  try {
    const { refreshToken } = Req.body;
    if (!refreshToken) return sendError(Res, 400, "Invalid request structure.", meta.requestId);

    let decoded;
    try {
      decoded = jwt.verify(refreshToken, config.refreshTokenSecret);
    } catch {
      await createAudit({ action: "refresh", outcome: "failed", reason: "invalid_token", requestId: meta.requestId, ipAddress: meta.ipAddress, device: meta.deviceId, browser: meta.userAgent });
      return sendError(Res, 401, "Invalid refresh token", meta.requestId);
    }

    if (decoded.type !== "refresh") {
      await createAudit({ action: "refresh", outcome: "failed", reason: "wrong_token_type", user: { _id: decoded.id }, requestId: meta.requestId, ipAddress: meta.ipAddress, device: meta.deviceId, browser: meta.userAgent });
      return sendError(Res, 401, "Invalid refresh token", meta.requestId);
    }

    const { sessionId, id: userId } = decoded;
    if (!sessionId || !userId) {
      await createAudit({ action: "refresh", outcome: "failed", reason: "malformed_token", requestId: meta.requestId, ipAddress: meta.ipAddress, device: meta.deviceId, browser: meta.userAgent });
      return sendError(Res, 401, "Invalid refresh token", meta.requestId);
    }

    const session = await SessionModel.findOne({ _id: sessionId, userId });
    if (!session || session.status !== "active") {
      await createAudit({ action: "refresh", outcome: "failed", reason: "session_not_found_or_inactive", user: { _id: userId }, sessionId: sessionId || null, requestId: meta.requestId, ipAddress: meta.ipAddress, device: meta.deviceId, browser: meta.userAgent });
      return sendError(Res, 401, "Invalid refresh token", meta.requestId);
    }

    if (session.expiresAt && new Date(session.expiresAt) < new Date()) {
      session.status = "expired";
      await session.save();
      await createAudit({ action: "refresh", outcome: "failed", reason: "session_expired", user: { _id: userId, email: session.email, tenantId: session.tenantId, branchId: session.branchId }, sessionId: session._id, requestId: meta.requestId, ipAddress: meta.ipAddress, device: meta.deviceId, browser: meta.userAgent });
      return sendError(Res, 401, "Expired refresh token", meta.requestId);
    }

    if (session.refreshTokenHash !== hashToken(refreshToken)) {
      // Reuse of an already-rotated refresh token is a strong signal of theft.
      // Security Rule 53 requires the compromised session be invalidated immediately.
      session.status = "revoked";
      session.revokedAt = new Date();
      await session.save();
      await createAudit({ action: "refresh", outcome: "failed", reason: "refresh_token_reuse_detected", user: { _id: userId, email: session.email, tenantId: session.tenantId, branchId: session.branchId }, sessionId: session._id, requestId: meta.requestId, ipAddress: meta.ipAddress, device: meta.deviceId, browser: meta.userAgent });
      publishEvent("SessionRevoked", { userId: String(userId), sessionId: String(session._id), reason: "refresh_token_reuse_detected", requestId: meta.requestId });
      return sendError(Res, 401, "Revoked refresh token", meta.requestId);
    }

    const user = await UserModel.findById(userId);
    if (!user || ["deleted", "suspended", "inactive"].includes(user.status)) {
      await createAudit({ action: "refresh", outcome: "failed", reason: "account_disabled", user: user || { _id: userId, email: session.email, tenantId: session.tenantId, branchId: session.branchId }, sessionId: session._id, requestId: meta.requestId, ipAddress: meta.ipAddress, device: meta.deviceId, browser: meta.userAgent });
      return sendError(Res, 403, "Disabled account", meta.requestId);
    }

    if (user.tenantId) {
      const tenant = await TenantModel.findOne({ tenantKey: user.tenantId, status: "active" }).lean();
      if (!tenant) {
        await createAudit({ action: "refresh", outcome: "failed", reason: "tenant_disabled", user, sessionId: session._id, requestId: meta.requestId, ipAddress: meta.ipAddress, device: meta.deviceId, browser: meta.userAgent });
        return sendError(Res, 403, "Disabled tenant", meta.requestId);
      }
    }

    const accessToken = createAccessToken({ email: user.email, id: user._id, sessionId: session._id, role: user.role, tenantId: session.tenantId, branchId: session.branchId });
    const nextRefreshToken = createRefreshToken({ email: user.email, id: user._id, sessionId: session._id, tenantId: session.tenantId, branchId: session.branchId }, session.rememberMe);
    session.refreshTokenHash = hashToken(nextRefreshToken);
    session.lastActivityAt = new Date();
    session.expiresAt = getRefreshTokenExpiryDate(session.rememberMe);
    await session.save();
    await createAudit({ action: "refresh", outcome: "success", user, sessionId: session._id, requestId: meta.requestId, ipAddress: meta.ipAddress, device: meta.deviceId, browser: meta.userAgent, metadata: { source: "refresh" } });
    publishEvent("TokenRefreshed", { userId: user._id.toString(), sessionId: session._id.toString(), requestId: meta.requestId });
    publishEvent("SessionUpdated", { userId: user._id.toString(), sessionId: session._id.toString(), tenantId: session.tenantId || null, branchId: session.branchId || null, expiresAt: session.expiresAt, requestId: meta.requestId });
    return sendSuccess(Res, 200, "Token refreshed.", { accessToken, refreshToken: nextRefreshToken, expiresIn: getAccessTokenExpiresInSeconds() }, meta.requestId);
  } catch (error) {
    logger.error("Refresh error", { error: error.message });
    return sendError(Res, 500, "Unexpected failure", meta.requestId);
  }
};

export const Me = async (Req, Res) => {
  const meta = getRequestMeta(Req);
  try {
    const userId = Req.auth?.id;
    const sessionId = Req.auth?.sessionId;
    if (!userId || !sessionId) return sendError(Res, 401, "Invalid JWT", meta.requestId);
    const session = await SessionModel.findOne({ _id: sessionId, userId, status: "active" });
    if (!session) return sendError(Res, 401, "Invalid JWT", meta.requestId);
    const user = await UserModel.findById(userId);
    if (!user || ["deleted", "suspended", "inactive"].includes(user.status)) return sendError(Res, 403, "Disabled Account", meta.requestId);

    // Neither the domain context nor preferences depend on one another —
    // resolve both in parallel to stay within the <150ms performance target.
    const [domain, preferences] = await Promise.all([
      resolveDomainContext(user),
      loadUserPreferences(userId),
    ]);

    let deniedReason = null;
    if (config.strictDomainAuth && (!user.tenantId || !user.branchId || !user.role || !domain.tenant || !domain.branch || !domain.role)) {
      deniedReason = { message: "Disabled Account", reason: "domain_context_required" };
    } else if (user.tenantId && !domain.tenant) {
      deniedReason = { message: "Disabled Tenant", reason: "tenant_disabled" };
    } else if (user.branchId && !domain.branch) {
      deniedReason = { message: "Disabled Branch", reason: "branch_disabled" };
    } else if (user.role && !domain.role) {
      deniedReason = { message: "Disabled Role", reason: "role_disabled" };
    }

    if (deniedReason) {
      if (config.meEndpointAuditEnabled) {
        await createAudit({ action: "me", outcome: "failed", reason: deniedReason.reason, user, sessionId: session._id, requestId: meta.requestId, ipAddress: meta.ipAddress, device: meta.deviceId, browser: meta.userAgent });
      }
      return sendError(Res, 403, deniedReason.message, meta.requestId);
    }

    if (config.meEndpointAuditEnabled) {
      await createAudit({ action: "me", outcome: "success", user, sessionId: session._id, requestId: meta.requestId, ipAddress: meta.ipAddress, device: meta.deviceId, browser: meta.userAgent });
    }

    return sendSuccess(Res, 200, "User profile loaded.", {
      id: user._id, fullName: user.username, email: user.email,
      role: { id: domain.role?._id || null, name: domain.role?.name || user.role },
      tenant: { id: domain.tenant?._id || user.tenantId, name: domain.tenant?.name || null, key: domain.tenant?.tenantKey || user.tenantId },
      branch: { id: domain.branch?._id || user.branchId, name: domain.branch?.name || null, key: domain.branch?.branchKey || user.branchId },
      permissions: domain.permissions,
      preferences,
    }, meta.requestId);
  } catch (error) {
    logger.error("Me error", { error: error.message });
    return sendError(Res, 500, "Unexpected failure", meta.requestId);
  }
};

export const Forgetpassword = async (Req, Res) => {
  try {
    const { email } = Req.body;
    const meta = getRequestMeta(Req);
    const user = await UserModel.findOne({ email });

    // Every rejection reason below must fold into the identical generic
    // response (Rule 1) — only the internally-audited `reason` differs.
    let ineligibleReason = null;
    if (user) {
      const isAccountDisabled = ["deleted", "suspended", "inactive"].includes(user.status) || user.isDeleted || user.isSuspended;
      if (isAccountDisabled) {
        ineligibleReason = "account_disabled";
      } else if (user.tenantId) {
        const tenant = await TenantModel.findOne({ tenantKey: user.tenantId, status: "active" }).lean();
        if (!tenant) ineligibleReason = "tenant_disabled";
      }
      if (!ineligibleReason) {
        const cooldownKey = `forgot-password-cooldown:${user._id}`;
        const inCooldown = await CacheManager.get(cooldownKey);
        if (inCooldown) ineligibleReason = "cooldown_active";
      }
    }

    if (user && !ineligibleReason) {
      await PasswordResetTokenModel.updateMany({ userId: user._id, active: true }, { $set: { active: false } });
      const resetToken = crypto.randomBytes(32).toString("hex");
      const tokenHash = hashResetToken(resetToken);
      const expiresAt = new Date(Date.now() + config.passwordResetTtlHours * 60 * 60 * 1000);
      await PasswordResetTokenModel.create({ userId: user._id, email: user.email, tokenHash, expiresAt, active: true });
      // Abuse-detection: block re-issuing another token for this user until the cooldown elapses.
      await CacheManager.set(`forgot-password-cooldown:${user._id}`, true, config.forgotPasswordCooldownSeconds);
      const resetUrl = `${config.frontendUrl}/reset-password?token=${resetToken}`;
      await queueEmail({
        to: user.email,
        subject: "Reset Your Password",
        html: buildEmailTemplate("Reset Your Password", [`Hi ${user.username},`, "We received a request to reset your password. Click the button below to create a new one.", `This link will expire in ${config.passwordResetTtlHours} hour${config.passwordResetTtlHours > 1 ? "s" : ""}.`, "If you didn't request this, please ignore this email."], resetUrl, "Reset Password"),
      });
      await createAudit({ action: "forgot-password", outcome: "success", user, requestId: meta.requestId, ipAddress: meta.ipAddress, device: meta.deviceId, browser: meta.userAgent, metadata: { resetTokenCreated: true } });
      publishEvent("PasswordResetRequested", { userId: user._id.toString(), email: user.email, requestId: meta.requestId });
      publishEvent("EmailQueued", { userId: user._id.toString(), email: user.email, purpose: "password_reset", requestId: meta.requestId });
    } else {
      await createAudit({ action: "forgot-password", outcome: "success", reason: ineligibleReason || "user_not_found", user, email, requestId: meta.requestId, ipAddress: meta.ipAddress, device: meta.deviceId, browser: meta.userAgent, metadata: { resetTokenCreated: false } });
    }
    return sendSuccess(Res, 200, "If an account exists for this email, password recovery instructions have been sent.", null, meta.requestId);
  } catch (error) {
    logger.error("Forget password error", { error: error.message });
    return sendError(Res, 500, "Unexpected failure", Req.requestId || uuidv4());
  }
};

export const Resetpassword = async (Req, Res) => {
  try {
    const { resetToken, newPassword } = Req.body;
    const meta = getRequestMeta(Req);
    const tokenHash = hashResetToken(resetToken);
    const storedToken = await PasswordResetTokenModel.findOne({ tokenHash, active: true });
    if (!storedToken) {
      await createAudit({ action: "reset-password", outcome: "failed", reason: "invalid_token", requestId: meta.requestId, ipAddress: meta.ipAddress, device: meta.deviceId, browser: meta.userAgent });
      return sendError(Res, 401, "Invalid token", meta.requestId);
    }
    if (storedToken.usedAt) {
      await createAudit({ action: "reset-password", outcome: "failed", reason: "token_already_used", email: storedToken.email, requestId: meta.requestId, ipAddress: meta.ipAddress, device: meta.deviceId, browser: meta.userAgent });
      return sendError(Res, 409, "Token already used", meta.requestId);
    }
    if (storedToken.expiresAt && new Date(storedToken.expiresAt) < new Date()) {
      storedToken.active = false; await storedToken.save();
      await createAudit({ action: "reset-password", outcome: "failed", reason: "token_expired", email: storedToken.email, requestId: meta.requestId, ipAddress: meta.ipAddress, device: meta.deviceId, browser: meta.userAgent });
      return sendError(Res, 401, "Expired token", meta.requestId);
    }
    const user = await UserModel.findById(storedToken.userId);
    if (!user) {
      await createAudit({ action: "reset-password", outcome: "failed", reason: "user_not_found", email: storedToken.email, requestId: meta.requestId, ipAddress: meta.ipAddress, device: meta.deviceId, browser: meta.userAgent });
      return sendError(Res, 401, "Invalid token", meta.requestId);
    }

    if (user.tenantId) {
      const tenant = await TenantModel.findOne({ tenantKey: user.tenantId, status: "active" }).lean();
      if (!tenant) {
        await createAudit({ action: "reset-password", outcome: "failed", reason: "tenant_disabled", user, requestId: meta.requestId, ipAddress: meta.ipAddress, device: meta.deviceId, browser: meta.userAgent });
        return sendError(Res, 403, "Disabled tenant", meta.requestId);
      }
    }

    const { valid, errors } = await validatePassword(newPassword, user.tenantId, user._id);
    if (!valid) {
      return sendError(Res, 422, "Password does not meet policy requirements.", meta.requestId, { errors });
    }
    const hash = await bcrypt.hash(newPassword, 10);
    await UserModel.findByIdAndUpdate(user._id, { password: hash, passwordChangedAt: new Date() });
    await recordPasswordHistory(user._id, hash, "reset", meta.requestId);
    storedToken.usedAt = new Date(); storedToken.active = false; await storedToken.save();
    const revokeResult = await SessionModel.updateMany({ userId: user._id, status: "active" }, { $set: { status: "revoked", revokedAt: new Date() } });
    await createAudit({ action: "reset-password", outcome: "success", user, requestId: meta.requestId, ipAddress: meta.ipAddress, device: meta.deviceId, browser: meta.userAgent, metadata: { tokenUsed: true, sessionsRevoked: revokeResult.modifiedCount } });
    publishEvent("PasswordResetCompleted", { userId: user._id.toString(), requestId: meta.requestId });
    if (revokeResult.modifiedCount > 0) {
      publishEvent("SessionsRevoked", { userId: user._id.toString(), count: revokeResult.modifiedCount, reason: "password_reset", requestId: meta.requestId });
    }
    publishEvent("SecurityNotificationRequested", { userId: user._id.toString(), email: user.email, type: "password_reset", requestId: meta.requestId });
    return sendSuccess(Res, 200, "Password reset successfully.", null, meta.requestId);
  } catch (error) {
    logger.error("Reset password error", { error: error.message });
    return sendError(Res, 500, "Unexpected failure", Req.requestId || uuidv4());
  }
};

export const Changepassword = async (Req, Res) => {
  try {
    const meta = getRequestMeta(Req);
    const userId = Req.auth?.id;
    const sessionId = Req.auth?.sessionId;
    const { currentPassword, newPassword } = Req.body;
    if (!userId || !sessionId) return sendError(Res, 401, "Invalid JWT", meta.requestId);

    const session = await SessionModel.findOne({ _id: sessionId, userId, status: "active" });
    if (!session) return sendError(Res, 401, "Invalid JWT", meta.requestId);

    const user = await UserModel.findById(userId);
    if (!user) return sendError(Res, 401, "Invalid JWT", meta.requestId);

    if (user.lockUntil && new Date(user.lockUntil) > new Date()) {
      await createAudit({ action: "change-password", outcome: "failed", reason: "account_locked", user, sessionId, requestId: meta.requestId, ipAddress: meta.ipAddress, device: meta.deviceId, browser: meta.userAgent });
      return sendError(Res, 423, "Account locked", meta.requestId);
    }

    if (["deleted", "suspended", "inactive"].includes(user.status) || user.isDeleted || user.isSuspended) {
      await createAudit({ action: "change-password", outcome: "failed", reason: "account_disabled", user, sessionId, requestId: meta.requestId, ipAddress: meta.ipAddress, device: meta.deviceId, browser: meta.userAgent });
      return sendError(Res, 403, "Disabled account", meta.requestId);
    }

    if (user.tenantId) {
      const tenant = await TenantModel.findOne({ tenantKey: user.tenantId, status: "active" }).lean();
      if (!tenant) {
        await createAudit({ action: "change-password", outcome: "failed", reason: "tenant_disabled", user, sessionId, requestId: meta.requestId, ipAddress: meta.ipAddress, device: meta.deviceId, browser: meta.userAgent });
        return sendError(Res, 403, "Disabled tenant", meta.requestId);
      }
    }

    if (!(await bcrypt.compare(currentPassword, user.password))) {
      await createAudit({ action: "change-password", outcome: "failed", reason: "invalid_current_password", user, sessionId, requestId: meta.requestId, ipAddress: meta.ipAddress, device: meta.deviceId, browser: meta.userAgent });
      return sendError(Res, 401, "Current password incorrect", meta.requestId);
    }
    if (newPassword === currentPassword) return sendError(Res, 400, "New password must differ from current password", meta.requestId);
    const { valid, errors } = await validatePassword(newPassword, user.tenantId, user._id);
    if (!valid) {
      return sendError(Res, 422, "Password does not meet policy requirements.", meta.requestId, { errors });
    }
    const hash = await bcrypt.hash(newPassword, 10);
    await UserModel.findByIdAndUpdate(user._id, { password: hash, passwordChangedAt: new Date() });
    await recordPasswordHistory(user._id, hash, "change", meta.requestId);

    let otherSessionsRevoked = 0;
    if (config.changePasswordRevokeOtherSessions) {
      const revokeResult = await SessionModel.updateMany({ userId: user._id, _id: { $ne: sessionId }, status: "active" }, { $set: { status: "revoked", revokedAt: new Date() } });
      otherSessionsRevoked = revokeResult.modifiedCount || 0;
    }

    await createAudit({ action: "change-password", outcome: "success", user, sessionId, requestId: meta.requestId, ipAddress: meta.ipAddress, device: meta.deviceId, browser: meta.userAgent, metadata: { otherSessionsRevoked } });
    publishEvent("PasswordChanged", { userId: user._id.toString(), sessionId: String(sessionId), requestId: meta.requestId });
    if (otherSessionsRevoked > 0) {
      publishEvent("SessionsRevoked", { userId: user._id.toString(), count: otherSessionsRevoked, reason: "password_changed", requestId: meta.requestId });
    }
    publishEvent("SecurityNotificationRequested", { userId: user._id.toString(), email: user.email, type: "password_changed", requestId: meta.requestId });

    return sendSuccess(Res, 200, "Password changed successfully.", null, meta.requestId);
  } catch (error) {
    logger.error("Change password error", { error: error.message });
    return sendError(Res, 500, "Unexpected failure", Req.requestId || uuidv4());
  }
};

export const SendEmailVerification = async (Req, Res) => {
  try {
    const meta = getRequestMeta(Req);
    const userId = Req.auth?.id;
    if (!userId) return sendError(Res, 401, "Invalid JWT", meta.requestId);
    const user = await UserModel.findById(userId);
    if (!user || ["deleted", "suspended", "inactive"].includes(user.status)) return sendError(Res, 403, "Account exists but cannot access the platform.", meta.requestId);
    if (user.Isverifed || user.emailVerified) return sendSuccess(Res, 200, "Email already verified.", null, meta.requestId);
    await issueEmailVerificationToken({ user, requestId: meta.requestId, ipAddress: meta.ipAddress, deviceId: meta.deviceId, userAgent: meta.userAgent });
    return sendSuccess(Res, 200, "Verification email sent.", null, meta.requestId);
  } catch (error) {
    logger.error("Send email verification error", { error: error.message });
    return sendError(Res, 500, "Unexpected failure", Req.requestId || uuidv4());
  }
};

export const VerifyEmail = async (Req, Res) => {
  try {
    const { verificationToken } = Req.body;
    const meta = getRequestMeta(Req);
    const tokenHash = hashVerificationToken(verificationToken);
    const storedToken = await EmailVerificationTokenModel.findOne({ tokenHash, active: true });
    if (!storedToken) {
      await createAudit({ action: "email-verify", outcome: "failed", reason: "invalid_token", requestId: meta.requestId, ipAddress: meta.ipAddress, device: meta.deviceId, browser: meta.userAgent });
      return sendError(Res, 401, "Invalid token", meta.requestId);
    }
    if (storedToken.usedAt) {
      await createAudit({ action: "email-verify", outcome: "failed", reason: "token_already_used", email: storedToken.email, requestId: meta.requestId, ipAddress: meta.ipAddress, device: meta.deviceId, browser: meta.userAgent });
      return sendError(Res, 409, "Token already used", meta.requestId);
    }
    if (storedToken.expiresAt && new Date(storedToken.expiresAt) < new Date()) {
      storedToken.active = false; await storedToken.save();
      await createAudit({ action: "email-verify", outcome: "failed", reason: "token_expired", email: storedToken.email, requestId: meta.requestId, ipAddress: meta.ipAddress, device: meta.deviceId, browser: meta.userAgent });
      return sendError(Res, 401, "Expired token", meta.requestId);
    }
    const user = await UserModel.findById(storedToken.userId);
    if (!user) {
      await createAudit({ action: "email-verify", outcome: "failed", reason: "user_not_found", email: storedToken.email, requestId: meta.requestId, ipAddress: meta.ipAddress, device: meta.deviceId, browser: meta.userAgent });
      return sendError(Res, 401, "Invalid token", meta.requestId);
    }
    const verifiedAt = new Date();
    await UserModel.findByIdAndUpdate(user._id, { Isverifed: true, emailVerified: true, emailVerifiedAt: verifiedAt });
    storedToken.usedAt = verifiedAt; storedToken.active = false; await storedToken.save();
    // Clears any other still-active verification requests for this user, not just the one used.
    await EmailVerificationTokenModel.updateMany({ userId: user._id, active: true }, { $set: { active: false } });
    await createAudit({ action: "email-verify", outcome: "success", user, requestId: meta.requestId, ipAddress: meta.ipAddress, device: meta.deviceId, browser: meta.userAgent, metadata: { emailVerified: true } });
    publishEvent("EmailVerified", { userId: user._id.toString(), requestId: meta.requestId });
    return sendSuccess(Res, 200, "Email verified.", null, meta.requestId);
  } catch (error) {
    logger.error("Verify email error", { error: error.message });
    return sendError(Res, 500, "Unexpected failure", Req.requestId || uuidv4());
  }
};

export const ListSessions = async (Req, Res) => {
  try {
    const meta = getRequestMeta(Req);
    const userId = Req.auth?.id;
    const currentSessionId = Req.auth?.sessionId ? String(Req.auth.sessionId) : null;
    if (!userId || !currentSessionId) return sendError(Res, 401, "Invalid JWT", meta.requestId);

    const parsedPage = parseInt(Req.query.page, 10);
    const page = Number.isFinite(parsedPage) && parsedPage > 0 ? parsedPage : 1;
    const parsedPageSize = parseInt(Req.query.pageSize, 10);
    const pageSize = Math.min(Math.max(Number.isFinite(parsedPageSize) ? parsedPageSize : 20, 1), 100);
    const status = Req.query.status || "active";
    const deviceType = Req.query.deviceType;
    const sort = Req.query.sort || "-lastActivityAt -createdAt";

    const filter = { userId };
    if (["active", "revoked", "expired"].includes(status)) filter.status = status;
    if (["desktop", "mobile", "tablet", "other"].includes(deviceType)) filter.deviceType = deviceType;

    if (config.sessionsListAuditEnabled) {
      await createAudit({ action: "sessions-list", outcome: "success", user: { _id: userId, email: Req.auth?.email, tenantId: Req.auth?.tenantId, branchId: Req.auth?.branchId }, sessionId: currentSessionId, requestId: meta.requestId, ipAddress: meta.ipAddress, device: meta.deviceId, browser: meta.userAgent });
    }

    const [sessions, total] = await Promise.all([
      SessionModel.find(filter).sort(sort).skip((page - 1) * pageSize).limit(pageSize).lean(),
      SessionModel.countDocuments(filter),
    ]);
    return sendSuccess(Res, 200, "Sessions loaded.", {
      data: sessions.map((s) => ({
        sessionId: s._id, device: s.deviceId || "Unknown device", browser: s.browser || s.userAgent || "Unknown",
        os: s.os || null, deviceType: s.deviceType || "other",
        ipAddress: s.ipAddress || null, country: s.country || null, city: s.city || null,
        createdAt: s.createdAt, lastActivity: s.lastActivityAt,
        isCurrentSession: String(s._id) === currentSessionId, status: s.status,
      })),
      meta: { page, pageSize, total },
    }, meta.requestId);
  } catch (error) {
    logger.error("List sessions error", { error: error.message });
    return sendError(Res, 500, "Unexpected failure", Req.requestId || uuidv4());
  }
};

export const RevokeSession = async (Req, Res) => {
  try {
    const meta = getRequestMeta(Req);
    const userId = Req.auth?.id;
    const currentSessionId = Req.auth?.sessionId;
    const targetSessionId = Req.params.sessionId;
    if (!userId || !currentSessionId) return sendError(Res, 401, "Invalid JWT", meta.requestId);

    const session = await SessionModel.findOne({ _id: targetSessionId, userId });
    if (!session) return sendError(Res, 404, "Session not found", meta.requestId);

    const user = await UserModel.findById(userId);
    const domain = user ? await resolveDomainContext(user) : null;
    if (user?.tenantId && !domain?.tenant) {
      await createAudit({ action: "session-revoke", outcome: "failed", reason: "tenant_disabled", user, sessionId: session._id, requestId: meta.requestId, ipAddress: meta.ipAddress, device: meta.deviceId, browser: meta.userAgent });
      return sendError(Res, 403, "Disabled tenant", meta.requestId);
    }
    if (user?.branchId && !domain?.branch) {
      await createAudit({ action: "session-revoke", outcome: "failed", reason: "branch_disabled", user, sessionId: session._id, requestId: meta.requestId, ipAddress: meta.ipAddress, device: meta.deviceId, browser: meta.userAgent });
      return sendError(Res, 403, "Disabled branch", meta.requestId);
    }

    if (session.status !== "revoked") {
      session.status = "revoked"; session.revokedAt = new Date(); session.lastActivityAt = new Date(); await session.save();
    }
    await createAudit({ action: "session-revoke", outcome: "success", reason: "user_requested", user: user || { _id: userId, email: Req.auth?.email, tenantId: Req.auth?.tenantId || session.tenantId, branchId: Req.auth?.branchId || session.branchId }, sessionId: session._id, requestId: meta.requestId, ipAddress: meta.ipAddress, device: meta.deviceId, browser: meta.userAgent, metadata: { currentSession: String(session._id) === String(currentSessionId) } });
    publishEvent("SessionRevoked", { userId: String(userId), sessionId: String(session._id), requestId: meta.requestId });
    publishEvent("UserSessionTerminated", { userId: String(userId), sessionId: String(session._id), requestId: meta.requestId });
    return sendSuccess(Res, 200, "Session revoked.", null, meta.requestId);
  } catch (error) {
    logger.error("Revoke session error", { error: error.message });
    return sendError(Res, 500, "Unexpected failure", Req.requestId || uuidv4());
  }
};

export const LogoutAll = async (Req, Res) => {
  try {
    const meta = getRequestMeta(Req);
    const userId = Req.auth?.id;
    const currentSessionId = Req.auth?.sessionId;
    if (!userId || !currentSessionId) return sendError(Res, 401, "Invalid JWT", meta.requestId);
    const result = await SessionModel.updateMany({ userId, status: "active" }, { $set: { status: "revoked", revokedAt: new Date() } });
    await createAudit({ action: "logout-all", outcome: "success", reason: "user_requested", user: { _id: userId, email: Req.auth?.email, tenantId: Req.auth?.tenantId, branchId: Req.auth?.branchId }, sessionId: currentSessionId, requestId: meta.requestId, ipAddress: meta.ipAddress, device: meta.deviceId, browser: meta.userAgent, metadata: { revokedCount: result.modifiedCount || 0 } });
    publishEvent("AllSessionsRevoked", { userId: String(userId), requestId: meta.requestId });
    publishEvent("UserSecurityUpdated", { userId: String(userId), reason: "logout_all", requestId: meta.requestId });
    // Reusing the same event name established for Change Password / Reset
    // Password rather than the doc's "NotificationsRequested" — one
    // consistent event for "notify the user of a security-relevant change"
    // is more useful to a downstream subscriber than three near-duplicates.
    publishEvent("SecurityNotificationRequested", { userId: String(userId), email: Req.auth?.email || null, type: "all_sessions_revoked", requestId: meta.requestId });
    return sendSuccess(Res, 200, "All sessions revoked.", null, meta.requestId);
  } catch (error) {
    logger.error("Logout all error", { error: error.message });
    return sendError(Res, 500, "Unexpected failure", Req.requestId || uuidv4());
  }
};

export const SetupMfa = async (Req, Res) => {
  try {
    const meta = getRequestMeta(Req);
    const userId = Req.auth?.id;
    const { method } = Req.body;
    if (!userId) return sendError(Res, 401, "Invalid JWT", meta.requestId);
    const user = await UserModel.findById(userId);
    if (!user) return sendError(Res, 401, "Invalid JWT", meta.requestId);
    if (user.mfaEnabled) return sendSuccess(Res, 200, "MFA is already enabled.", { mfaEnabled: true, mfaMethod: user.mfaMethod }, meta.requestId);
    // Defense in depth beyond the Joi schema: SMS delivery is not wired to
    // any provider, so it must never silently fall back to email.
    if (method === "sms") {
      await createAudit({ action: "mfa-setup", outcome: "failed", reason: "sms_not_available", user, requestId: meta.requestId, ipAddress: meta.ipAddress, device: meta.deviceId, browser: meta.userAgent });
      return sendError(Res, 400, "SMS-based MFA is not currently available. Please use an authenticator app or email.", meta.requestId);
    }
    if (method === "totp") {
      const secret = authenticator.generateSecret();
      const issuer = config.appName;
      const otpauthUrl = authenticator.keyuri(user.email, issuer, secret);
      const encrypted = encryptMfaValue(secret);
      user.mfaPendingSecretEncrypted = encrypted.encrypted;
      user.mfaPendingSecretIv = encrypted.iv;
      user.mfaPendingSecretAuthTag = encrypted.authTag;
      user.mfaSetupChallenge = { codeHash: null, expiresAt: new Date(Date.now() + config.mfaCodeTtlMinutes * 60 * 1000), method: "totp" };
      await user.save();
      await createAudit({ action: "mfa-setup", outcome: "initiated", reason: "totp", user, requestId: meta.requestId, ipAddress: meta.ipAddress, device: meta.deviceId, browser: meta.userAgent });
      return sendSuccess(Res, 200, "MFA setup initialized.", {
        mfaMethod: "totp", otpauthUrl,
        secret: config.nodeEnv !== "production" ? secret : undefined,
      }, meta.requestId);
    }
    const setupCode = Math.floor(100000 + Math.random() * 900000).toString();
    user.mfaSetupChallenge = { codeHash: hashCode(setupCode), expiresAt: new Date(Date.now() + config.mfaCodeTtlMinutes * 60 * 1000), method };
    await user.save();
    await sendMfaEmailCode({ toEmail: user.email, username: user.username, code: setupCode, purpose: "setup" });
    await createAudit({ action: "mfa-setup", outcome: "initiated", reason: "email", user, requestId: meta.requestId, ipAddress: meta.ipAddress, device: meta.deviceId, browser: meta.userAgent });
    return sendSuccess(Res, 200, "MFA setup code sent.", { mfaMethod: method }, meta.requestId);
  } catch (error) {
    logger.error("Setup MFA error", { error: error.message });
    return sendError(Res, 500, "Unexpected failure", Req.requestId || uuidv4());
  }
};

export const VerifyMfaSetup = async (Req, Res) => {
  try {
    const meta = getRequestMeta(Req);
    const userId = Req.auth?.id;
    const { code } = Req.body;
    if (!userId) return sendError(Res, 401, "Invalid JWT", meta.requestId);
    if (!code) return sendError(Res, 400, "MFA verification code is required", meta.requestId);
    const user = await UserModel.findById(userId);
    if (!user) return sendError(Res, 401, "Invalid JWT", meta.requestId);
    const challenge = user.mfaSetupChallenge;
    if (!challenge?.method || !challenge.expiresAt) return sendError(Res, 400, "No MFA setup in progress", meta.requestId);
    if (new Date(challenge.expiresAt) < new Date()) {
      await createAudit({ action: "mfa-setup", outcome: "failed", reason: "challenge_expired", user, requestId: meta.requestId, ipAddress: meta.ipAddress, device: meta.deviceId, browser: meta.userAgent });
      return sendError(Res, 401, "MFA setup challenge expired", meta.requestId);
    }
    if (challenge.method === "totp") {
      const secret = decryptMfaValue(user.mfaPendingSecretEncrypted, user.mfaPendingSecretIv, user.mfaPendingSecretAuthTag);
      if (!secret || !authenticator.check(code, secret)) {
        await createAudit({ action: "mfa-setup", outcome: "failed", reason: "invalid_code", user, requestId: meta.requestId, ipAddress: meta.ipAddress, device: meta.deviceId, browser: meta.userAgent });
        return sendError(Res, 401, "Invalid MFA code", meta.requestId);
      }
      user.mfaSecretEncrypted = user.mfaPendingSecretEncrypted;
      user.mfaSecretIv = user.mfaPendingSecretIv;
      user.mfaSecretAuthTag = user.mfaPendingSecretAuthTag;
    } else {
      if (!challenge.codeHash || hashCode(code) !== challenge.codeHash) {
        await createAudit({ action: "mfa-setup", outcome: "failed", reason: "invalid_code", user, requestId: meta.requestId, ipAddress: meta.ipAddress, device: meta.deviceId, browser: meta.userAgent });
        return sendError(Res, 401, "Invalid MFA code", meta.requestId);
      }
    }
    const recoveryCodes = generateRecoveryCodes();
    user.mfaEnabled = true;
    user.mfaMethod = challenge.method;
    user.mfaRequired = true;
    user.mfaLastVerifiedAt = new Date();
    user.mfaSetupChallenge = { codeHash: null, expiresAt: null, method: null };
    user.mfaPendingSecretEncrypted = challenge.method === "totp" ? user.mfaPendingSecretEncrypted : null;
    user.mfaPendingSecretIv = challenge.method === "totp" ? user.mfaPendingSecretIv : null;
    user.mfaPendingSecretAuthTag = challenge.method === "totp" ? user.mfaPendingSecretAuthTag : null;
    user.mfaRecoveryCodes = recoveryCodes.map((rc) => ({ hash: hashCode(rc) }));
    user.mfaPendingRecoveryCodes = [];
    await user.save();
    await createAudit({ action: "mfa-setup", outcome: "success", user, requestId: meta.requestId, ipAddress: meta.ipAddress, device: meta.deviceId, browser: meta.userAgent, metadata: { method: user.mfaMethod } });
    publishEvent("MFAEnabled", { userId: user._id.toString(), method: user.mfaMethod, requestId: meta.requestId });
    return sendSuccess(Res, 200, "MFA setup completed.", { recoveryCodes }, meta.requestId);
  } catch (error) {
    logger.error("Verify MFA setup error", { error: error.message });
    return sendError(Res, 500, "Unexpected failure", Req.requestId || uuidv4());
  }
};

export const CompleteMfaLogin = async (Req, Res) => {
  try {
    const { mfaToken, code, recoveryCode } = Req.body;
    const meta = getRequestMeta(Req);
    if (!mfaToken) return sendError(Res, 400, "MFA token is required", meta.requestId);
    let payload;
    try { payload = jwt.verify(mfaToken, config.accessTokenSecret); } catch { return sendError(Res, 401, "Invalid MFA token", meta.requestId); }
    if (!payload?.loginMfa || !payload?.id) return sendError(Res, 401, "Invalid MFA flow", meta.requestId);
    const user = await UserModel.findById(payload.id);
    if (!user || !user.mfaEnabled) return sendError(Res, 401, "MFA not enabled for this account", meta.requestId);
    const challenge = user.mfaLoginChallenge;
    if (!challenge?.method || !challenge.expiresAt) return sendError(Res, 400, "No MFA login challenge available", meta.requestId);
    if (new Date(challenge.expiresAt) < new Date()) {
      await createAudit({ action: "mfa-login", outcome: "failed", reason: "challenge_expired", user, requestId: meta.requestId, ipAddress: meta.ipAddress, device: meta.deviceId, browser: meta.userAgent });
      return sendError(Res, 401, "MFA challenge expired", meta.requestId);
    }
    const verifyResult = await verifyMfaPayload(user, code || null, recoveryCode || null);
    if (!verifyResult.success) {
      if (challenge.attempts >= 4) {
        user.mfaLoginChallenge = { codeHash: null, expiresAt: null, attempts: 0, method: null }; await user.save();
      }
      await createAudit({ action: "mfa-login", outcome: "failed", reason: verifyResult.reason || "invalid_code", user, requestId: meta.requestId, ipAddress: meta.ipAddress, device: meta.deviceId, browser: meta.userAgent });
      return sendError(Res, 401, "Invalid MFA code", meta.requestId);
    }
    user.mfaLoginChallenge = { codeHash: null, expiresAt: null, attempts: 0, method: null };
    user.mfaLastVerifiedAt = new Date();
    await user.save();
    const { session, accessToken, refreshToken } = await createSessionAndTokens(user, meta, payload.rememberMe);
    await createAudit({ action: "mfa-login", outcome: "success", user, sessionId: session._id, requestId: meta.requestId, ipAddress: meta.ipAddress, device: meta.deviceId, browser: meta.userAgent, metadata: { method: user.mfaMethod, loginType: verifyResult.type } });
    await recordLoginHistory({ user, sessionId: session._id, action: "mfa_login", status: "success", meta });
    publishEvent("MFAVerified", { userId: user._id.toString(), sessionId: session._id.toString(), method: user.mfaMethod, verificationType: verifyResult.type, requestId: meta.requestId });
    return sendSuccess(Res, 200, "Login successful.", {
      accessToken, refreshToken, expiresIn: getAccessTokenExpiresInSeconds(),
      user: { id: user._id, fullName: user.username, email: user.email, role: user.role, tenantId: user.tenantId, branchId: user.branchId },
    }, meta.requestId);
  } catch (error) {
    logger.error("Complete MFA login error", { error: error.message });
    return sendError(Res, 500, "Unexpected failure", Req.requestId || uuidv4());
  }
};

export const DisableMfa = async (Req, Res) => {
  try {
    const meta = getRequestMeta(Req);
    const userId = Req.auth?.id;
    const { password, code } = Req.body;
    if (!userId) return sendError(Res, 401, "Invalid JWT", meta.requestId);
    if (!password) return sendError(Res, 400, "Password is required to disable MFA", meta.requestId);
    const user = await UserModel.findById(userId);
    if (!user) return sendError(Res, 401, "Invalid JWT", meta.requestId);
    if (!(await bcrypt.compare(password, user.password))) {
      await createAudit({ action: "mfa-disable", outcome: "failed", reason: "invalid_password", user, requestId: meta.requestId, ipAddress: meta.ipAddress, device: meta.deviceId, browser: meta.userAgent });
      return sendError(Res, 401, "Invalid password", meta.requestId);
    }

    if (!user.mfaEnabled) return sendSuccess(Res, 200, "MFA is already disabled.", null, meta.requestId);

    if (user.mfaMethod === "totp") {
      if (!code) return sendError(Res, 400, "MFA code is required to disable TOTP", meta.requestId);
      const secret = decryptMfaValue(user.mfaSecretEncrypted, user.mfaSecretIv, user.mfaSecretAuthTag);
      if (!secret || !authenticator.check(code, secret)) {
        await createAudit({ action: "mfa-disable", outcome: "failed", reason: "invalid_code", user, requestId: meta.requestId, ipAddress: meta.ipAddress, device: meta.deviceId, browser: meta.userAgent });
        return sendError(Res, 401, "Invalid MFA code", meta.requestId);
      }
    } else if (user.mfaMethod === "email" || user.mfaMethod === "sms") {
      // "Only after successful verification" applies to every method, not
      // just TOTP — a stolen password alone must never be enough to turn
      // off email/SMS-based MFA. Two-step, mirroring Setup/Verify above:
      // step 1 (no code yet) sends a fresh disable-confirmation code;
      // step 2 verifies it before the disable actually happens.
      if (!code) {
        const disableCode = Math.floor(100000 + Math.random() * 900000).toString();
        user.mfaDisableChallenge = { codeHash: hashCode(disableCode), expiresAt: new Date(Date.now() + config.mfaCodeTtlMinutes * 60 * 1000), method: user.mfaMethod };
        await user.save();
        // Legacy "sms" accounts (method no longer selectable at setup) fall
        // back to email delivery here rather than being permanently unable
        // to ever disable MFA.
        await sendMfaEmailCode({ toEmail: user.email, username: user.username, code: disableCode, purpose: "disable" });
        await createAudit({ action: "mfa-disable", outcome: "challenge", reason: user.mfaMethod, user, requestId: meta.requestId, ipAddress: meta.ipAddress, device: meta.deviceId, browser: meta.userAgent });
        return sendSuccess(Res, 200, "Verification code sent. Submit it to confirm disabling MFA.", { mfaMethod: user.mfaMethod, codeRequired: true }, meta.requestId);
      }
      const challenge = user.mfaDisableChallenge;
      if (!challenge?.codeHash || !challenge.expiresAt || new Date(challenge.expiresAt) < new Date() || hashCode(code) !== challenge.codeHash) {
        await createAudit({ action: "mfa-disable", outcome: "failed", reason: "invalid_or_expired_code", user, requestId: meta.requestId, ipAddress: meta.ipAddress, device: meta.deviceId, browser: meta.userAgent });
        return sendError(Res, 401, "Invalid or expired MFA code", meta.requestId);
      }
    }

    user.mfaEnabled = false; user.mfaMethod = null; user.mfaRequired = false;
    user.mfaSecretEncrypted = null; user.mfaSecretIv = null; user.mfaSecretAuthTag = null;
    user.mfaRecoveryCodes = []; user.mfaPendingRecoveryCodes = [];
    user.mfaSetupChallenge = { codeHash: null, expiresAt: null, method: null };
    user.mfaLoginChallenge = { codeHash: null, expiresAt: null, attempts: 0, method: null };
    user.mfaDisableChallenge = { codeHash: null, expiresAt: null, method: null };
    await user.save();
    await createAudit({ action: "mfa-disable", outcome: "success", user, requestId: meta.requestId, ipAddress: meta.ipAddress, device: meta.deviceId, browser: meta.userAgent });
    publishEvent("MFADisabled", { userId: user._id.toString(), requestId: meta.requestId });
    return sendSuccess(Res, 200, "MFA disabled successfully.", null, meta.requestId);
  } catch (error) {
    logger.error("Disable MFA error", { error: error.message });
    return sendError(Res, 500, "Unexpected failure", Req.requestId || uuidv4());
  }
};

export const MfaStatus = async (Req, Res) => {
  try {
    const meta = getRequestMeta(Req);
    const userId = Req.auth?.id;
    if (!userId) return sendError(Res, 401, "Invalid JWT", meta.requestId);
    const user = await UserModel.findById(userId);
    if (!user) return sendError(Res, 401, "Invalid JWT", meta.requestId);
    return sendSuccess(Res, 200, "MFA status loaded.", {
      mfaEnabled: user.mfaEnabled, mfaMethod: user.mfaMethod, mfaRequired: user.mfaRequired,
      recoveryCodesCount: (user.mfaRecoveryCodes || []).filter((e) => !e.usedAt).length,
      lastVerifiedAt: user.mfaLastVerifiedAt, setupPending: Boolean(user.mfaSetupChallenge?.method),
    }, meta.requestId);
  } catch (error) {
    logger.error("MFA status error", { error: error.message });
    return sendError(Res, 500, "Unexpected failure", Req.requestId || uuidv4());
  }
};

export const GetSecurityCenter = async (Req, Res) => {
  try {
    const meta = getRequestMeta(Req);
    const userId = Req.auth?.id;
    const currentSessionId = Req.auth?.sessionId;
    if (!userId) return sendError(Res, 401, "Invalid JWT", meta.requestId);
    const user = await UserModel.findById(userId);
    if (!user) return sendError(Res, 401, "Invalid JWT", meta.requestId);
    const activeSessions = await SessionModel.find({ userId: user._id, status: "active" }).sort({ lastActivityAt: -1 }).limit(20).lean();
    return sendSuccess(Res, 200, "Security center loaded.", {
      mfaEnabled: user.mfaEnabled, mfaMethod: user.mfaMethod, mfaRequired: user.mfaRequired,
      emailVerified: user.Isverifed || user.emailVerified, lastLoginAt: user.lastLoginAt, passwordChangedAt: user.passwordChangedAt,
      activeSessions: activeSessions.map((s) => ({
        sessionId: s._id, device: s.deviceId || "Unknown device", browser: s.browser || s.userAgent || "Unknown",
        ipAddress: s.ipAddress || null, lastActivityAt: s.lastActivityAt, current: String(s._id) === String(currentSessionId),
      })),
      activeSessionCount: activeSessions.length,
    }, meta.requestId);
  } catch (error) {
    logger.error("Security center error", { error: error.message });
    return sendError(Res, 500, "Unexpected failure", Req.requestId || uuidv4());
  }
};

export const UpdatePreferences = async (Req, Res) => {
  try {
    const meta = getRequestMeta(Req);
    const userId = Req.auth?.id;
    if (!userId) return sendError(Res, 401, "Invalid JWT", meta.requestId);
    const allowedFields = ["language", "timezone", "theme", "dateFormat", "timeFormat", "pageSize", "notifications", "dashboardLayout"];
    const updates = {};
    for (const key of allowedFields) {
      if (Req.body[key] !== undefined) updates[key] = Req.body[key];
    }
    if (Object.keys(updates).length === 0) return sendError(Res, 400, "No valid preference fields provided", meta.requestId);
    const prefs = await UserPreferenceModel.findOneAndUpdate(
      { userId },
      { $set: updates },
      { upsert: true, new: true, lean: true }
    );
    return sendSuccess(Res, 200, "Preferences updated.", prefs, meta.requestId);
  } catch (error) {
    logger.error("Update preferences error", { error: error.message });
    return sendError(Res, 500, "Unexpected failure", Req.requestId || uuidv4());
  }
};

export const GetPreferences = async (Req, Res) => {
  try {
    const meta = getRequestMeta(Req);
    const userId = Req.auth?.id;
    if (!userId) return sendError(Res, 401, "Invalid JWT", meta.requestId);
    const prefs = await loadUserPreferences(userId);
    return sendSuccess(Res, 200, "Preferences loaded.", prefs, meta.requestId);
  } catch (error) {
    logger.error("Get preferences error", { error: error.message });
    return sendError(Res, 500, "Unexpected failure", Req.requestId || uuidv4());
  }
};

export const GetLoginHistory = async (Req, Res) => {
  try {
    const meta = getRequestMeta(Req);
    const userId = Req.auth?.id;
    if (!userId) return sendError(Res, 401, "Invalid JWT", meta.requestId);
    const page = Math.max(parseInt(Req.query.page || "1", 10), 1);
    const pageSize = Math.min(Math.max(parseInt(Req.query.pageSize || "20", 10), 1), 100);
    const status = Req.query.status;
    const search = Req.query.search || "";
    const sort = Req.query.sort || "-createdAt";
    const filter = { userId };
    if (status && ["success", "failed"].includes(status)) filter.status = status;
    if (search) {
      filter.$or = [
        { ipAddress: new RegExp(search, "i") },
        { browser: new RegExp(search, "i") },
        { os: new RegExp(search, "i") },
        { country: new RegExp(search, "i") },
        { city: new RegExp(search, "i") },
      ];
    }
    const [items, total] = await Promise.all([
      LoginHistoryModel.find(filter).sort(sort).skip((page - 1) * pageSize).limit(pageSize).lean(),
      LoginHistoryModel.countDocuments(filter),
    ]);
    return sendSuccess(Res, 200, "Login history loaded.", {
      data: items.map((item) => ({
        id: item._id, action: item.action, status: item.status, failureReason: item.failureReason,
        ipAddress: item.ipAddress, country: item.country, city: item.city,
        browser: item.browser, os: item.os, deviceId: item.deviceId,
        riskScore: item.riskScore, isSuspicious: item.isSuspicious, createdAt: item.createdAt,
      })),
      meta: { page, pageSize, total },
    }, meta.requestId);
  } catch (error) {
    logger.error("Get login history error", { error: error.message });
    return sendError(Res, 500, "Unexpected failure", Req.requestId || uuidv4());
  }
};

export const GetSecurityEvents = async (Req, Res) => {
  try {
    const meta = getRequestMeta(Req);
    const userId = Req.auth?.id;
    if (!userId) return sendError(Res, 401, "Invalid JWT", meta.requestId);
    const page = Math.max(parseInt(Req.query.page || "1", 10), 1);
    const pageSize = Math.min(Math.max(parseInt(Req.query.pageSize || "20", 10), 1), 100);
    const action = Req.query.action || "";
    const sort = Req.query.sort || "-createdAt";
    const securityActions = [
      "login", "logout", "refresh", "change-password", "reset-password", "forgot-password",
      "email-verify", "email-send-verification", "mfa-setup", "mfa-disable", "mfa-login",
      "session-revoke", "logout-all", "account-unlock", "trusted-device-add", "trusted-device-remove",
    ];
    const filter = { userId };
    if (action && securityActions.includes(action)) filter.action = action;
    else filter.action = { $in: securityActions };
    const [items, total] = await Promise.all([
      AuditLogModel.find(filter).sort(sort).skip((page - 1) * pageSize).limit(pageSize).lean(),
      AuditLogModel.countDocuments(filter),
    ]);
    return sendSuccess(Res, 200, "Security events loaded.", {
      data: items.map((item) => ({
        id: item._id, action: item.action, outcome: item.outcome, reason: item.reason,
        ipAddress: item.ipAddress, device: item.device, browser: item.browser,
        metadata: item.metadata, createdAt: item.createdAt,
      })),
      meta: { page, pageSize, total },
    }, meta.requestId);
  } catch (error) {
    logger.error("Get security events error", { error: error.message });
    return sendError(Res, 500, "Unexpected failure", Req.requestId || uuidv4());
  }
};

export const GetTrustedDevices = async (Req, Res) => {
  try {
    const meta = getRequestMeta(Req);
    const userId = Req.auth?.id;
    if (!userId) return sendError(Res, 401, "Invalid JWT", meta.requestId);
    const page = Math.max(parseInt(Req.query.page || "1", 10), 1);
    const pageSize = Math.min(Math.max(parseInt(Req.query.pageSize || "20", 10), 1), 100);
    const [items, total] = await Promise.all([
      TrustedDeviceModel.find({ userId, isActive: true }).sort({ lastUsedAt: -1 }).skip((page - 1) * pageSize).limit(pageSize).lean(),
      TrustedDeviceModel.countDocuments({ userId, isActive: true }),
    ]);
    return sendSuccess(Res, 200, "Trusted devices loaded.", {
      data: items.map((item) => ({
        id: item._id, deviceId: item.deviceId, deviceName: item.deviceName,
        browser: item.browser, os: item.os, ipAddress: item.ipAddress,
        trustedAt: item.trustedAt, lastUsedAt: item.lastUsedAt,
      })),
      meta: { page, pageSize, total },
    }, meta.requestId);
  } catch (error) {
    logger.error("Get trusted devices error", { error: error.message });
    return sendError(Res, 500, "Unexpected failure", Req.requestId || uuidv4());
  }
};

export const AddTrustedDevice = async (Req, Res) => {
  try {
    const meta = getRequestMeta(Req);
    const userId = Req.auth?.id;
    if (!userId) return sendError(Res, 401, "Invalid JWT", meta.requestId);
    const { deviceId, deviceName } = Req.body;
    if (!deviceId) return sendError(Res, 400, "Device ID is required", meta.requestId);
    const ua = meta.userAgent || "";
    const osMatch = ua.match(/\((.*?)\)/);
    const os = osMatch ? osMatch[1].split(";")[0].trim() : null;
    const browserMatch = ua.match(/(Chrome|Firefox|Safari|Edge|Opera|MSIE|Trident)[/\s]/);
    const browser = browserMatch ? browserMatch[0].trim() : (meta.userAgent || "Unknown");
    const existing = await TrustedDeviceModel.findOne({ userId, deviceId });
    if (existing) {
      existing.lastUsedAt = new Date();
      existing.browser = browser;
      existing.os = os;
      existing.ipAddress = meta.ipAddress;
      existing.userAgent = meta.userAgent;
      existing.isActive = true;
      await existing.save();
      return sendSuccess(Res, 200, "Trusted device updated.", { id: existing._id, deviceId }, meta.requestId);
    }
    const device = await TrustedDeviceModel.create({
      userId, deviceId, deviceName: deviceName || null,
      browser, os, userAgent: meta.userAgent,
      ipAddress: meta.ipAddress, lastUsedAt: new Date(),
    });
    await createAudit({ action: "trusted-device-add", outcome: "success", user: { _id: userId, email: Req.auth?.email }, requestId: meta.requestId, ipAddress: meta.ipAddress, device: meta.deviceId, browser: meta.userAgent });
    publishEvent("TrustedDeviceAdded", { userId: String(userId), deviceId, requestId: meta.requestId });
    return sendSuccess(Res, 201, "Device trusted.", { id: device._id, deviceId }, meta.requestId);
  } catch (error) {
    logger.error("Add trusted device error", { error: error.message });
    return sendError(Res, 500, "Unexpected failure", Req.requestId || uuidv4());
  }
};

export const RemoveTrustedDevice = async (Req, Res) => {
  try {
    const meta = getRequestMeta(Req);
    const userId = Req.auth?.id;
    if (!userId) return sendError(Res, 401, "Invalid JWT", meta.requestId);
    const targetDeviceId = Req.params.deviceId;
    if (!targetDeviceId) return sendError(Res, 400, "Device ID is required", meta.requestId);
    const device = await TrustedDeviceModel.findOne({ userId, deviceId: targetDeviceId });
    if (!device) return sendError(Res, 404, "Trusted device not found", meta.requestId);
    device.isActive = false;
    await device.save();
    await createAudit({ action: "trusted-device-remove", outcome: "success", user: { _id: userId, email: Req.auth?.email }, requestId: meta.requestId, ipAddress: meta.ipAddress, device: meta.deviceId, browser: meta.userAgent });
    publishEvent("TrustedDeviceRemoved", { userId: String(userId), deviceId: targetDeviceId, requestId: meta.requestId });
    return sendSuccess(Res, 200, "Trusted device removed.", null, meta.requestId);
  } catch (error) {
    logger.error("Remove trusted device error", { error: error.message });
    return sendError(Res, 500, "Unexpected failure", Req.requestId || uuidv4());
  }
};

export const RequestAccountUnlock = async (Req, Res) => {
  try {
    const { email } = Req.body;
    const meta = getRequestMeta(Req);
    if (!email) return sendError(Res, 400, "Email is required", meta.requestId);
    const user = await UserModel.findOne({ email });
    if (user && user.lockUntil && new Date(user.lockUntil) > new Date()) {
      const unlockToken = crypto.randomBytes(32).toString("hex");
      const tokenHash = hashResetToken(unlockToken);
      const expiresAt = new Date(Date.now() + config.mfaCodeTtlMinutes * 60 * 1000);
      user.unlockRequestToken = tokenHash;
      user.unlockRequestExpiresAt = expiresAt;
      await user.save();
      const unlockUrl = `${config.frontendUrl}/unlock-account?token=${unlockToken}&email=${encodeURIComponent(email)}`;
      await sendEmail({
        to: user.email,
        subject: "Account Unlock Request",
        html: buildEmailTemplate("Account Unlock", [`Hi ${user.username},`, "Click the button below to unlock your account.", "This link expires in 10 minutes."], unlockUrl, "Unlock Account"),
      });
      await createAudit({ action: "account-unlock", outcome: "success", user, requestId: meta.requestId, ipAddress: meta.ipAddress, device: meta.deviceId, browser: meta.userAgent, metadata: { unlockRequested: true } });
      publishEvent("AccountUnlockRequested", { userId: user._id.toString(), email: user.email, requestId: meta.requestId });
    } else if (user && !user.lockUntil) {
      await createAudit({ action: "account-unlock", outcome: "failed", reason: "account_not_locked", user, requestId: meta.requestId, ipAddress: meta.ipAddress, device: meta.deviceId, browser: meta.userAgent });
    }
    return sendSuccess(Res, 200, "If your account is locked, an unlock link has been sent to your email.", null, meta.requestId);
  } catch (error) {
    logger.error("Account unlock error", { error: error.message });
    return sendError(Res, 500, "Unexpected failure", Req.requestId || uuidv4());
  }
};
