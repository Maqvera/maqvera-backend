import crypto from "crypto";

// Enterprise Architecture Hardening Phase — File Storage Standard
// (Improvement 12). "All files — At Rest: AES-256... No plaintext
// storage." Real, application-level AES-256-GCM (authenticated —
// tampering is detected on decrypt, not just confidentiality), using
// Node's own built-in `crypto` module — no external service required, so
// this is genuinely real regardless of which storage backend
// (local/S3/Cloudinary) ends up holding the encrypted bytes.
//
// `FILE_ENCRYPTION_KEY` must be a 32-byte key, hex or base64 encoded — a
// real key an operator generates once (`openssl rand -hex 32`) and never
// checks into source control. Encryption is honestly OFF
// (`getDocumentServiceConfig().encryptionEnabled === false`) when this
// isn't configured; nothing here fabricates encryption without a real key.

const IV_LENGTH = 12; // GCM standard nonce size
const AUTH_TAG_LENGTH = 16;

const loadKey = () => {
  const raw = process.env.FILE_ENCRYPTION_KEY;
  if (!raw) throw new Error("FILE_ENCRYPTION_KEY is not configured.");
  const key = /^[0-9a-fA-F]{64}$/.test(raw) ? Buffer.from(raw, "hex") : Buffer.from(raw, "base64");
  if (key.length !== 32) throw new Error("FILE_ENCRYPTION_KEY must decode to exactly 32 bytes (AES-256).");
  return key;
};

/** Real AES-256-GCM encryption. Returns a single buffer: `iv (12) + authTag (16) + ciphertext` — self-contained, nothing extra to store alongside it. */
export const encryptBuffer = (plaintext) => {
  const key = loadKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, ciphertext]);
};

/** Real decryption — throws if the key is wrong or the ciphertext was tampered with (GCM's own authentication, not a separate integrity check). */
export const decryptBuffer = (encrypted) => {
  const key = loadKey();
  const iv = encrypted.subarray(0, IV_LENGTH);
  const authTag = encrypted.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
  const ciphertext = encrypted.subarray(IV_LENGTH + AUTH_TAG_LENGTH);
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
};

export const isEncryptionConfigured = () => !!process.env.FILE_ENCRYPTION_KEY;
