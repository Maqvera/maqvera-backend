import QRCode from "qrcode";
import crypto from "crypto";
import InvoiceModel from "../models/InvoiceModel.js";
import BookingVoucherModel from "../models/BookingVoucherModel.js";

/**
 * Per-booking dynamic QR for Invoice/Client Voucher PDFs — mirrors
 * services/ReceiptQrService.js's exact shape (same crypto strength, same
 * `qrcode` package usage) rather than inventing a second QR pattern.
 * Scanning the code takes anyone straight to that one document's PDF, no
 * login required — same "public-token-as-access-control" convention this
 * codebase already uses for Receipt verify/download, customer-payment
 * links, and the customer portal (see routes/FinanceRoutes.js).
 */
class InvoiceDocumentQrService {
  /** Cryptographically random, unguessable token — the real access control for the public view route (not the invoice/voucher _id). */
  static generateAccessToken() {
    return crypto.randomBytes(24).toString("hex");
  }

  static buildViewUrl(baseUrl, token) {
    return `${baseUrl.replace(/\/$/, "")}/api/v1/documents/view/${token}`;
  }

  /** Returns a PNG Buffer — *PdfService.js base64-encodes it into a data: URI for the template's <img>, same pattern as ReceiptPdfService.js. */
  static async generateQrPngBuffer(viewUrl) {
    return QRCode.toBuffer(viewUrl, { type: "png", margin: 1, width: 200 });
  }

  /**
   * Public lookup for GET /api/v1/documents/view/:token (controllers/
   * DocumentViewController.js). Checks both document types the token could
   * belong to — a single indexed-field match per model, never a broader
   * query, so a wrong/guessed token can't leak cross-tenant data. Returns
   * null (caller sends 404) when the token matches neither.
   */
  static async resolveByToken(token) {
    const [invoice, voucher] = await Promise.all([
      InvoiceModel.findOne({ qrAccessToken: token }).lean(),
      BookingVoucherModel.findOne({ qrAccessToken: token }).lean()
    ]);

    if (invoice) return { type: "invoice", documentNumber: invoice.invoiceNumber, pdfUrl: invoice.pdf?.url || null };
    if (voucher) return { type: "voucher", documentNumber: voucher.voucherNumber, pdfUrl: voucher.pdfUrl || null };
    return null;
  }
}

export default InvoiceDocumentQrService;
