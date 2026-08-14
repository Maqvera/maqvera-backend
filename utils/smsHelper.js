import crypto from "crypto";

/**
 * Utility functions for Enterprise SMS Platform.
 * Supports phone validation, GSM-7/UCS-2 encoding detection, segment calculation, and OTP generation.
 */

// GSM 7-bit default alphabet character set regex
const GSM_7BIT_REGEX = /^[\x0A\x0D\x20-\x5F\x61-\x7E\u20AC\u00A1\u00A3\u00A4\u00A5\u00A7\u00BF\u00E0\u00E1\u00E2\u00E4\u00E8\u00E9\u00EC\u00F2\u00F9\u00FC\u00F1\u00F2\u00F3\u00F4\u00F6\u00D8\u00F8\u00C5\u00E5\u00C6\u00E6\u00DF\u00C9]*$/;

/**
 * Validate E.164 international phone number format
 * e.g., +923001234567, +14155552671
 */
export const validatePhoneNumber = (phone) => {
  if (!phone || typeof phone !== "string") return false;
  const cleanPhone = phone.trim();
  // E.164 format regex: optional +, followed by 7 to 15 digits
  const e164Regex = /^\+?[1-9]\d{6,14}$/;
  return e164Regex.test(cleanPhone);
};

/**
 * Standardize phone number format to E.164 (adds leading '+' if missing digits starting with country code)
 */
export const formatPhoneNumber = (phone) => {
  if (!phone) return "";
  let clean = phone.trim().replace(/[\s\-\(\)]/g, "");
  if (!clean.startsWith("+") && /^[1-9]\d+$/.test(clean)) {
    clean = `+${clean}`;
  }
  return clean;
};

/**
 * Detect text encoding (GSM-7 vs UCS-2 Unicode) and calculate segment/part count
 * GSM-7: 160 chars for single segment, 153 chars per segment if multi-part.
 * UCS-2 (Unicode - Arabic, Urdu, Chinese, Japanese, Emoji, etc.): 70 chars single, 67 chars per segment if multi-part.
 */
export const detectEncodingAndSegments = (text = "") => {
  const content = String(text || "");
  const isGsm7 = GSM_7BIT_REGEX.test(content);
  const encoding = isGsm7 ? "GSM-7" : "UCS-2";

  const charCount = content.length;
  let segmentCount = 1;

  if (encoding === "GSM-7") {
    if (charCount > 160) {
      segmentCount = Math.ceil(charCount / 153);
    }
  } else {
    // UCS-2 Unicode
    if (charCount > 70) {
      segmentCount = Math.ceil(charCount / 67);
    }
  }

  return {
    encoding,
    characterCount: charCount,
    segmentCount,
    isUnicode: !isGsm7
  };
};

/**
 * Generate secure numeric OTP code of specified length (default 6 digits)
 */
export const generateSecureOtpCode = (length = 6) => {
  const digits = "0123456789";
  let otp = "";
  for (let i = 0; i < length; i++) {
    const randomIndex = crypto.randomInt(0, digits.length);
    otp += digits[randomIndex];
  }
  return otp;
};
