import path from "path";
import { renderHtmlToPdfBuffer, TEMPLATES_DIR } from "./HtmlPdfRenderer.js";

// "Invoice Types: Commercial, Tax, Proforma, Recurring, Deposit,
// Installment, Credit, Debit, Subscription, Custom." Real, if modest,
// type-awareness — mirrors services/ReceiptPdfService.js's TEMPLATE_TITLES
// pattern (same reasoning: the field changes visible PDF content, not
// stored-but-unused).
const TYPE_TITLES = {
  Commercial: "COMMERCIAL INVOICE",
  Tax: "TAX INVOICE",
  Proforma: "PROFORMA INVOICE",
  Recurring: "RECURRING INVOICE",
  Deposit: "DEPOSIT INVOICE",
  Installment: "INSTALLMENT INVOICE",
  Credit: "CREDIT INVOICE",
  Debit: "DEBIT INVOICE",
  Subscription: "SUBSCRIPTION INVOICE",
  Custom: "INVOICE"
};

const TEMPLATE_PATH = path.join(TEMPLATES_DIR, "invoices", "default_invoice.html");

/**
 * HTML-template + headless-Chromium PDF generation (services/HtmlPdfRenderer.js)
 * — PRD "HTML-Template PDF Architecture Migration". Same public contract as
 * the pdfkit-era version this replaced: give it structured data, get a PDF
 * Buffer back — every caller (InvoiceService.js) needed zero changes.
 *
 * `company` (name/logoUrl/vatNumber/registrationNumber/address/phone/
 * email/bankDetails) is optional — a tenant with no profile set up yet
 * still gets a valid invoice, just without a branding header — never a
 * fabricated placeholder company name (templates/shared/partials/
 * companyHeader.hbs guards every field with {{#if}}).
 *
 * `bookingDetails` (guestName/paxCount/hotels[]) is populated only when
 * this invoice was generated from a booking (InvoiceService.
 * _resolveBookingDetailsForPdf). `documentSettings` (termsAndConditions/
 * cancellationPolicy/operationalContacts) — PRD "HTML-Template PDF
 * Architecture Migration" Issue 5 — is optional, same TenantProfileModel
 * source as BookingVoucherPdfService's own terms/cancellation/contacts
 * blocks. No pricing/tax logic lives in the
 * template — those numbers already arrive fully computed in `items`/
 * `subtotal`/`taxTotal`/`grandTotal`; the template only renders them.
 */
class InvoicePdfService {
  static async generatePdfBuffer({
    invoiceNumber, invoiceType, status, issueDate, dueDate, customerName, client, currency, items, subtotal, taxTotal, discountTotal,
    municipalityFeeRate, municipalityFeeAmount, grandTotal, company, bookingDetails, documentSettings, qrCodeDataUri, hijriDateFormatted, paidAmount, printedBy
  }) {
    return renderHtmlToPdfBuffer(TEMPLATE_PATH, {
      title: TYPE_TITLES[invoiceType] || TYPE_TITLES.Custom,
      isDraft: status === "Draft",
      invoiceNumber,
      status,
      issueDate,
      dueDate,
      customerName,
      client,
      currency,
      items,
      subtotal,
      taxTotal,
      discountTotal,
      municipalityFeeRate,
      municipalityFeeAmount,
      grandTotal,
      company,
      bookingDetails,
      documentSettings,
      qrCodeDataUri,
      hijriDateFormatted,
      paidAmount,
      printedBy
    });
  }
}

export default InvoicePdfService;
