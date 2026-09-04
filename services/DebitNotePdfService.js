import path from "path";
import { renderHtmlToPdfBuffer, TEMPLATES_DIR } from "./HtmlPdfRenderer.js";

const TEMPLATE_PATH = path.join(TEMPLATES_DIR, "debit-notes", "default_debit_note.html");

/**
 * HTML-template + headless-Chromium PDF generation (services/HtmlPdfRenderer.js)
 * — PRD "HTML-Template PDF Architecture Migration". Same public contract as
 * the pdfkit-era version this replaced — party-aware: labels the
 * counterparty row "Customer"/"Vendor" and the reference row "Against
 * Invoice"/"Against Payable" depending on partyType, since a Debit Note can
 * target either. The party-aware label choice is resolved here in JS
 * (rather than replicated as ternaries in the template) to keep the
 * template a pure rendering layer.
 */
class DebitNotePdfService {
  static async generatePdfBuffer({ debitNumber, status, issuedAt, partyType, invoiceNumber, customerName, vendorName, reason, currency, items, debitAmount, taxAdjustmentTotal, grandTotal, company }) {
    const isVendor = partyType === "Vendor";
    return renderHtmlToPdfBuffer(TEMPLATE_PATH, {
      isDraft: status === "Draft",
      debitNumber,
      issuedAt: issuedAt || new Date(),
      invoiceNumber,
      referenceLabel: isVendor ? "Against Payable" : "Against Invoice",
      partyLabel: isVendor ? "Vendor" : "Customer",
      partyName: isVendor ? vendorName : customerName,
      referencedThing: isVendor ? "payable" : "invoice",
      reason,
      currency,
      items,
      debitAmount,
      taxAdjustmentTotal,
      grandTotal,
      company
    });
  }
}

export default DebitNotePdfService;
