import crypto from "crypto";

// Generic AES-256-GCM field encryption — mirrors controllers/Auth.js's own
// encryptMfaValue/decryptMfaValue exactly (same algorithm, same key
// derivation via SHA-256 of an env secret), extracted here as a reusable
// utility for the first NON-auth sensitive field in this codebase: bank
// account numbers (Finance Module Part 13's "Security... Encryption"
// requirement). Deliberately its own small implementation rather than a
// refactor of Auth.js's private functions — same proven pattern, kept
// independent so a change here can never affect MFA secret handling.
//
// Key: `BANK_ACCOUNT_ENCRYPTION_KEY` if set, otherwise falls back to the
// already-mandatory `MFA_ENCRYPTION_KEY` (config/envValidator.js hard-fails
// startup if that one is missing/insecure, so this always has a real key
// available without requiring a second mandatory secret for this feature).
const getEncryptionKey = () => {
  const secret = process.env.BANK_ACCOUNT_ENCRYPTION_KEY || process.env.MFA_ENCRYPTION_KEY;
  return crypto.createHash("sha256").update(secret).digest();
};

/** Encrypts a plaintext string. Returns { encrypted, iv, authTag } (all base64). */
export const encryptField = (value) => {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", getEncryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(String(value), "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return {
    encrypted: encrypted.toString("base64"),
    iv: iv.toString("base64"),
    authTag: authTag.toString("base64")
  };
};

/** Decrypts the { encrypted, iv, authTag } shape encryptField produces. Returns null on any failure. */
export const decryptField = ({ encrypted, iv, authTag } = {}) => {
  if (!encrypted || !iv || !authTag) return null;
  try {
    const decipher = crypto.createDecipheriv("aes-256-gcm", getEncryptionKey(), Buffer.from(iv, "base64"));
    decipher.setAuthTag(Buffer.from(authTag, "base64"));
    const result = Buffer.concat([decipher.update(Buffer.from(encrypted, "base64")), decipher.final()]);
    return result.toString("utf8");
  } catch {
    return null;
  }
};

/**
 * Deterministic hash of a normalized value — used ONLY for uniqueness
 * checks/exact-match lookups (e.g. "Unique Account Number"), never for
 * display or decryption. AES-GCM ciphertext is never equal across two
 * encryptions of the same plaintext (fresh random IV every time), so a
 * uniqueness constraint can't be enforced on `encrypted` directly — this
 * hash is the real, correct mechanism for that, same hashing convention
 * `controllers/Auth.js` already uses for reset/verification tokens.
 */
export const hashField = (value) => crypto.createHash("sha256").update(String(value).trim().toUpperCase()).digest("hex");

/** "Account Number (Masked)" — real masking, last 4 characters only. */
export const maskAccountNumber = (accountNumber) => {
  const digits = String(accountNumber || "").trim();
  if (digits.length <= 4) return "*".repeat(digits.length);
  return `${"*".repeat(digits.length - 4)}${digits.slice(-4)}`;
};
