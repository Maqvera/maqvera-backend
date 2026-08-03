import dotenv from "dotenv";
dotenv.config();

const parseInteger = (value, fallback) => {
  const parsed = parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const buildEmailIdentity = (name, address) => {
  return address ? `${name || "MAQVERA"} <${address}>` : (name || "MAQVERA");
};

export const getAuthConfig = () => {
  const appName = process.env.APP_NAME || "MAQVERA";
  const emailFromName = process.env.EMAIL_FROM_NAME || appName;
  const emailFromAddress = process.env.EMAIL_FROM || process.env.SMTP_USER || "";

  const parseBoolean = (value, fallback) => {
    if (typeof value === "boolean") return value;
    if (typeof value === "string") {
      const normalized = value.trim().toLowerCase();
      if (["1", "true", "yes", "on"].includes(normalized)) return true;
      if (["0", "false", "no", "off"].includes(normalized)) return false;
    }
    return fallback;
  };

  return {
    appName,
    accessTokenSecret: process.env.ACCESS_TOKEN_SECRET || process.env.PRIVATE_KEY,
    refreshTokenSecret: process.env.REFRESH_TOKEN_SECRET || process.env.PRIVATE_KEY,
    accessTokenExpiresIn: process.env.ACCESS_TOKEN_EXPIRES_IN || "15m",
    refreshTokenExpiresIn: process.env.REFRESH_TOKEN_EXPIRES_IN || "30d",
    refreshTokenExpiresDays: parseInteger(process.env.REFRESH_TOKEN_EXPIRES_DAYS, 30),
    refreshTokenRememberMeExpiresIn: process.env.REFRESH_TOKEN_REMEMBER_ME_EXPIRES_IN || "90d",
    refreshTokenRememberMeExpiresDays: parseInteger(process.env.REFRESH_TOKEN_REMEMBER_ME_EXPIRES_DAYS, 90),
    frontendUrl: process.env.FRONTEND_URL || "http://localhost:5173",
    emailFrom: buildEmailIdentity(emailFromName, emailFromAddress),
    emailFromAddress,
    emailFromName,
    smtpHost: process.env.SMTP_HOST || "",
    smtpPort: parseInteger(process.env.SMTP_PORT, 587),
    smtpSecure: process.env.SMTP_SECURE === "true",
    smtpUser: process.env.SMTP_USER || "",
    smtpPass: process.env.SMTP_PASS || "",
    loginLockoutMinutes: parseInteger(process.env.LOGIN_LOCKOUT_MINUTES, 15),
    maxLoginAttempts: parseInteger(process.env.MAX_LOGIN_ATTEMPTS, 5),
    passwordResetTtlHours: parseInteger(process.env.PASSWORD_RESET_TTL_HOURS, 1),
    emailVerificationTtlHours: parseInteger(process.env.EMAIL_VERIFICATION_TTL_HOURS, 24),
    mfaCodeTtlMinutes: parseInteger(process.env.MFA_CODE_TTL_MINUTES, 10),
    mfaTokenTtlMinutes: parseInteger(process.env.MFA_TOKEN_TTL_MINUTES, 10),
    rateLimitWindowMs: parseInteger(process.env.RATE_LIMIT_WINDOW_MS, 600000),
    rateLimitMaxRequests: parseInteger(process.env.RATE_LIMIT_MAX_REQUESTS, 100),
    mfaEncryptionKey: process.env.MFA_ENCRYPTION_KEY,
    strictDomainAuth: process.env.STRICT_AUTH_DOMAIN === "true",
    passwordMinLength: parseInteger(process.env.PASSWORD_MIN_LENGTH, 8),
    passwordRequireUppercase: parseBoolean(process.env.PASSWORD_REQUIRE_UPPERCASE, true),
    passwordRequireLowercase: parseBoolean(process.env.PASSWORD_REQUIRE_LOWERCASE, true),
    passwordRequireNumber: parseBoolean(process.env.PASSWORD_REQUIRE_NUMBER, true),
    passwordRequireSpecial: parseBoolean(process.env.PASSWORD_REQUIRE_SPECIAL, true),
    defaultTimezone: process.env.DEFAULT_TIMEZONE || "UTC",
    defaultLanguage: process.env.DEFAULT_LANGUAGE || "en",
    defaultTheme: process.env.DEFAULT_THEME || "light",
    defaultDateFormat: process.env.DEFAULT_DATE_FORMAT || "YYYY-MM-DD",
    defaultCurrencyFormat: process.env.DEFAULT_CURRENCY_FORMAT || "USD",
    invitationExpiryDays: parseInteger(process.env.INVITATION_EXPIRY_DAYS, 7),
    bcryptSaltRounds: parseInteger(process.env.BCRYPT_SALT_ROUNDS, 10),
    employeeCodePrefix: process.env.EMPLOYEE_CODE_PREFIX || "EMP",
    maxPageSize: parseInteger(process.env.MAX_PAGE_SIZE, 100),
    defaultPageSize: parseInteger(process.env.DEFAULT_PAGE_SIZE, 20),
    emailSendAsync: process.env.EMAIL_SEND_ASYNC !== "false",
    nodeEnv: process.env.NODE_ENV || "development",
    // GET /auth/me is called on every page load/refresh across the whole
    // frontend; auditing it is opt-in so it doesn't flood the audit log by default.
    meEndpointAuditEnabled: parseBoolean(process.env.ME_ENDPOINT_AUDIT_ENABLED, false),
    changePasswordRevokeOtherSessions: parseBoolean(process.env.CHANGE_PASSWORD_REVOKE_OTHER_SESSIONS, true),
    // Abuse-detection cooldown: blocks re-issuing a reset token/email for the
    // same user more than once within this window (Forgot Password Section 91).
    forgotPasswordCooldownSeconds: parseInteger(process.env.FORGOT_PASSWORD_COOLDOWN_SECONDS, 60),
    // GET /auth/sessions is a routine "view my devices" call; audit is opt-in for the same reason as /me.
    sessionsListAuditEnabled: parseBoolean(process.env.SESSIONS_LIST_AUDIT_ENABLED, false),
    // Abuse-detection cooldown: blocks resending an employee invitation more
    // than once within this window (User Management resend-invitation "Rate limited" rule).
    resendInvitationCooldownSeconds: parseInteger(process.env.RESEND_INVITATION_COOLDOWN_SECONDS, 60),
  };
};
