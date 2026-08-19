import path from "path";
import { renderHtmlToPdfBuffer, TEMPLATES_DIR } from "./HtmlPdfRenderer.js";

// "Receipt Templates: Retail, Corporate, Government, POS, Subscription,
// Travel, Visa, Custom." Real, if modest, template-awareness — the header
// title changes per template rather than the field being stored-but-unused.
const TEMPLATE_TITLES = {
  Default: "RECEIPT",
  Retail: "SALES RECEIPT",
  Corporate: "OFFICIAL RECEIPT",
  Government: "GOVERNMENT RECEIPT",
  POS: "POINT OF SALE RECEIPT",
  Subscription: "SUBSCRIPTION PAYMENT RECEIPT",
  Travel: "TRAVEL SERVICES RECEIPT",
  Visa: "VISA SERVICES RECEIPT",
  Custom: "RECEIPT"
};

const TEMPLATE_PATH = path.join(TEMPLATES_DIR, "receipts", "default_receipt.html");

/**
 * HTML-template + headless-Chromium PDF generation (services/HtmlPdfRenderer.js)
 * — PRD "HTML-Template PDF Architecture Migration". Same public contract as
 * the pdfkit-era version this replaced — the generated buffer is what's
 * actually stored (see utils/documentPdfStorage.js) and served back to the
 * caller.
 *
 * `qrPngBuffer` is a real in-memory Buffer (ReceiptQrService), not a URL —
 * converted to a data: URI here so the template's <img> never needs
 * Chromium to fetch anything for it (unlike `company.logoUrl`, which is a
 * real remote/local URL Chromium fetches directly).
 */
class ReceiptPdfService {
  static async generatePdfBuffer({ receiptNumber, template, issueDate, amount, currency, paymentNumber, partyName, allocations = [], qrPngBuffer, company }) {
    return renderHtmlToPdfBuffer(TEMPLATE_PATH, {
      title: TEMPLATE_TITLES[template] || TEMPLATE_TITLES.Default,
      receiptNumber,
      issueDate,
      amount,
      currency,
      paymentNumber,
      partyName,
      allocations,
      qrDataUri: qrPngBuffer ? `data:image/png;base64,${qrPngBuffer.toString("base64")}` : null,
      company
    });
  }
}

export default ReceiptPdfService;
