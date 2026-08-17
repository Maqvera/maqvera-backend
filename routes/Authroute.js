import express from "express";
import {
  Signup, SetupTenantIntent, Login, Forgetpassword, Changepassword, Logout, Refresh, Me, Resetpassword,
  SendEmailVerification, VerifyEmail, ListSessions, RevokeSession, LogoutAll,
  SetupMfa, VerifyMfaSetup, CompleteMfaLogin, DisableMfa, MfaStatus, GetSecurityCenter,
  UpdatePreferences, GetPreferences, GetLoginHistory, GetSecurityEvents,
  GetTrustedDevices, AddTrustedDevice, RemoveTrustedDevice, RequestAccountUnlock,
} from "../controllers/Auth.js";
import authenticateAccessToken from "../middleware/authenticateAccessToken.js";
import validate, { authSchemas } from "../middleware/validateRequest.js";
import rateLimit from "express-rate-limit";
import { getAuthConfig } from "../utils/authConfig.js";
import { upload } from "../services/FileUploadService.js";

const route = express.Router();
const config = getAuthConfig();

const limiter = rateLimit({
  windowMs: config.rateLimitWindowMs,
  limit: config.rateLimitMaxRequests,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { success: false, message: `Too many requests, please try again after ${config.rateLimitWindowMs / 60000} minutes.` },
});

// =====================
// AUTH
// =====================
route.post("/signup", limiter, validate(authSchemas.signup), Signup);
// Per-Tenant Payment Gateway Integration (PRD Issue 12) — this endpoint's
// own contract changed: it now creates a real Stripe Checkout Session
// (returns `{ checkoutUrl }`) instead of the company/account immediately.
// The real TenantModel/UserModel creation now happens only once payment
// completes, via the `checkout.session.completed` webhook.
route.post("/setup", limiter, validate(authSchemas.setupTenant), SetupTenantIntent);
route.post("/login", limiter, validate(authSchemas.login), Login);
route.post("/logout", authenticateAccessToken, validate(authSchemas.logout), Logout);
route.post("/refresh", limiter, validate(authSchemas.refresh), Refresh);
route.get("/me", authenticateAccessToken, Me);

// =====================
// PASSWORD
// =====================
route.post("/forgot-password", limiter, validate(authSchemas.forgotPassword), Forgetpassword);
route.post("/forgetpassword", limiter, validate(authSchemas.forgotPassword), Forgetpassword);
route.post("/reset-password", limiter, validate(authSchemas.resetPassword), Resetpassword);
route.post("/change-password", authenticateAccessToken, limiter, validate(authSchemas.changePassword), Changepassword);
route.post("/changepassword", authenticateAccessToken, limiter, validate(authSchemas.changePassword), Changepassword);

// =====================
// EMAIL VERIFICATION
// =====================
route.post("/email/send-verification", authenticateAccessToken, limiter, SendEmailVerification);
route.post("/email/verify", limiter, validate(authSchemas.verifyEmail), VerifyEmail);

// =====================
// SESSIONS
// =====================
route.get("/sessions", authenticateAccessToken, ListSessions);
route.delete("/sessions/:sessionId", authenticateAccessToken, RevokeSession);
route.post("/logout-all", authenticateAccessToken, LogoutAll);

// =====================
// MFA
// =====================
route.post("/mfa/setup", authenticateAccessToken, limiter, validate(authSchemas.setupMfa), SetupMfa);
route.post("/mfa/verify", authenticateAccessToken, limiter, validate(authSchemas.verifyMfaSetup), VerifyMfaSetup);
route.post("/mfa/login", limiter, validate(authSchemas.completeMfaLogin), CompleteMfaLogin);
route.post("/mfa/disable", authenticateAccessToken, limiter, validate(authSchemas.disableMfa), DisableMfa);
route.get("/mfa/status", authenticateAccessToken, MfaStatus);

// =====================
// SECURITY CENTER
// =====================
route.get("/security", authenticateAccessToken, GetSecurityCenter);
route.get("/login-history", authenticateAccessToken, GetLoginHistory);
route.get("/security-events", authenticateAccessToken, GetSecurityEvents);

// =====================
// TRUSTED DEVICES
// =====================
route.get("/trusted-devices", authenticateAccessToken, GetTrustedDevices);
route.post("/trusted-devices", authenticateAccessToken, validate(authSchemas.addTrustedDevice), AddTrustedDevice);
route.delete("/trusted-devices/:deviceId", authenticateAccessToken, RemoveTrustedDevice);

// =====================
// ACCOUNT
// =====================
route.post("/account/unlock-request", limiter, validate(authSchemas.forgotPassword), RequestAccountUnlock);

// =====================
// PREFERENCES (DB-driven)
// =====================
route.get("/preferences", authenticateAccessToken, GetPreferences);
route.patch("/preferences", authenticateAccessToken, UpdatePreferences);

// =====================
// PROFILE AVATAR UPLOAD
// =====================
route.post("/avatar", authenticateAccessToken, upload.single("avatar"), async (Req, Res) => {
  try {
    const file = Req.file;
    if (!file) return Res.status(400).json({ success: false, message: "No file uploaded", requestId: Req.requestId });
    const url = file.path || file.secure_url || `/uploads/${file.filename}`;
    await UserModel.findByIdAndUpdate(Req.auth.id, { avatar: url });
    return Res.json({ success: true, message: "Avatar updated.", data: { url }, requestId: Req.requestId });
  } catch (err) {
    return Res.status(500).json({ success: false, message: err.message, requestId: Req.requestId });
  }
});

export default route;
