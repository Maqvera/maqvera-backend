import dotenv from "dotenv";
dotenv.config();

const CRITICAL_VARS = [
  { key: "ACCESS_TOKEN_SECRET", name: "JWT Access Token Secret" },
  { key: "REFRESH_TOKEN_SECRET", name: "JWT Refresh Token Secret" },
  { key: "MFA_ENCRYPTION_KEY", name: "MFA Encryption Key" },
];

const WARN_VARS = [
  { key: "SMTP_HOST", name: "SMTP Host" },
  { key: "SMTP_USER", name: "SMTP User" },
  { key: "SMTP_PASS", name: "SMTP Password" },
  { key: "URI", name: "MongoDB URI" },
];

const WARN_IF_MISSING = [
  { key: "FRONTEND_URL", name: "Frontend URL" },
  { key: "REDIS_URL", name: "Redis URL (cache will fall back to in-memory)" },
  { key: "STRIPE_SECRET_KEY", name: "Stripe Secret Key (Stripe gateway payments will be unavailable)" },
  { key: "TWILIO_ACCOUNT_SID", name: "Twilio Account SID (WhatsApp/SMS receipt delivery will be unavailable)" },
  // Per-Tenant Payment Gateway Integration (Stripe Connect). Deliberately
  // WARN, not CRITICAL — same treatment as STRIPE_SECRET_KEY directly
  // above, for the same reason: Stripe is optional, per-tenant-opt-in
  // infrastructure throughout this codebase (an agency that hasn't
  // connected a payment account yet still uses the rest of the ERP fine),
  // never something the whole app refuses to boot without. The real,
  // hard failure for a genuinely missing signing secret happens at the
  // point of use — `PaymentWebhookController` refuses to verify (and
  // therefore refuses to process) any webhook if `STRIPE_WEBHOOK_SECRET`
  // is unset, the same "throw a clear, honest error, never fabricate
  // success" discipline `StripeGatewayAdapter._requireClient()` already
  // established — not a boot-time gate that would break every
  // Stripe-Connect-not-yet-configured deployment.
  { key: "STRIPE_WEBHOOK_SECRET", name: "Stripe Webhook Signing Secret (Stripe webhook events will be rejected until this is set)" },
  { key: "STRIPE_CONNECT_CLIENT_ID", name: "Stripe Connect OAuth Client ID (agencies will not be able to connect their own Stripe account)" },
];

const isProduction = process.env.NODE_ENV === "production";

export const validateEnv = () => {
  const errors = [];
  const warnings = [];

  for (const { key, name } of CRITICAL_VARS) {
    if (!process.env[key] || process.env[key].includes("default-") || process.env[key] === "your-") {
      errors.push(`Missing or insecure ${name} (${key}). Set it in .env`);
    }
  }

  for (const { key, name } of WARN_VARS) {
    if (!process.env[key]) {
      if (isProduction) {
        warnings.push(`Missing ${name} (${key}) in .env — this will fail in production`);
      }
    }
  }

  for (const { key, name } of WARN_IF_MISSING) {
    if (!process.env[key]) {
      warnings.push(`Consider setting ${name} (${key}) in .env`);
    }
  }

  const storageBackend = String(process.env.FILE_STORAGE_BACKEND || "local").toLowerCase();
  const requiredStorageVariables = {
    cloudinary: ["CLOUDINARY_CLOUD_NAME", "CLOUDINARY_API_KEY", "CLOUDINARY_API_SECRET"],
    s3: ["S3_BUCKET", "S3_REGION", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY"],
  };
  if (!['local', 'cloudinary', 's3'].includes(storageBackend)) {
    errors.push("FILE_STORAGE_BACKEND must be one of: local, cloudinary, s3.");
  }
  for (const key of requiredStorageVariables[storageBackend] || []) {
    if (!process.env[key]) errors.push(`Missing storage configuration (${key}) for FILE_STORAGE_BACKEND=${storageBackend}.`);
  }
  if (storageBackend !== "local" && !process.env.DOCUMENT_STORAGE_BASE_URL && !process.env.FILE_STORAGE_BASE_URL) {
    warnings.push("Set DOCUMENT_STORAGE_BASE_URL for externally accessible document links.");
  }

  if (errors.length > 0) {
    console.error("\n==============================================");
    console.error("  ENVIRONMENT VALIDATION FAILED");
    console.error("==============================================");
    for (const err of errors) {
      console.error(`  ❌ ${err}`);
    }
    console.error("==============================================\n");
    process.exit(1);
  }

  if (warnings.length > 0) {
    console.warn("\n⚠️  Environment Warnings:");
    for (const warn of warnings) {
      console.warn(`  ⚠️  ${warn}`);
    }
    console.warn("");
  }

  return true;
};
