import path from "path";
import { renderHtmlToPdfBuffer, TEMPLATES_DIR } from "./HtmlPdfRenderer.js";

const TEMPLATE_PATH = path.join(TEMPLATES_DIR, "credit-notes", "default_credit_note.html");

/**
 * HTML-template + headless-Chromium PDF generation (services/HtmlPdfRenderer.js)
 * — PRD "HTML-Template PDF Architecture Migration". Same public contract as
 * the pdfkit-era version this replaced — an actual credit note document
 * referencing the original invoice.
 */
class CreditNotePdfService {
  static async generatePdfBuffer({ creditNumber, status, issuedAt, invoiceNumber, customerName, reason, currency, items, creditAmount, taxAdjustmentTotal, grandTotal, disposition, company }) {
    return renderHtmlToPdfBuffer(TEMPLATE_PATH, {
      isDraft: status === "Draft",
      creditNumber,
      issuedAt: issuedAt || new Date(),
      invoiceNumber,
      customerName,
      reason,
      currency,
      items,
      creditAmount,
      taxAdjustmentTotal,
      grandTotal,
      disposition,
      company
    });
  }
}

export default CreditNotePdfService;
