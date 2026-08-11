import QRCode from "qrcode";
import crypto from "crypto";

/**
 * Real QR code generation (the `qrcode` npm package — no external service,
 * no credentials needed, always available). Encodes the public
 * verification URL so scanning the code takes anyone straight to
 * "Receipt Valid / Payment Verified" — "QR Verification... Supports fraud
 * prevention."
 */
class ReceiptQrService {
  /** Cryptographically random, unguessable token — the real access control for the public endpoints (not the receiptId). */
  static generateVerificationToken() {
    return crypto.randomBytes(24).toString("hex");
  }

  static buildVerificationUrl(baseUrl, token) {
    return `${baseUrl.replace(/\/$/, "")}/api/v1/receipts/verify/${token}`;
  }

  /** Returns a PNG Buffer, embeddable directly into the PDF via pdfkit's doc.image(). */
  static async generateQrPngBuffer(verificationUrl) {
    return QRCode.toBuffer(verificationUrl, { type: "png", margin: 1, width: 200 });
  }
}

export default ReceiptQrService;
