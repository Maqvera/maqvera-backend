import path from "path";
import { renderHtmlToPdfBuffer, TEMPLATES_DIR } from "./HtmlPdfRenderer.js";

const TEMPLATE_PATH = path.join(TEMPLATES_DIR, "vouchers", "hotel_voucher.html");

/**
 * Agency-branded Client Voucher PDF (booking-module PRD Part B item #7) —
 * HTML-template + headless-Chromium rendering (services/HtmlPdfRenderer.js),
 * PRD "HTML-Template PDF Architecture Migration". Same public contract as
 * the pdfkit-era version this replaced. Layout follows Document 3 §45:
 * company header -> CLIENT VOUCHER title + ref/generated-by -> client/guest
 * section -> service section -> room/service detail lines -> terms ->
 * cancellation policy -> operational contacts.
 *
 * `company` (name/logoUrl/address/vatNumber/registrationNumber) and
 * `documentSettings` (termsAndConditions/cancellationPolicy/
 * operationalContacts) are optional — this service renders whatever it's
 * given and never fabricates placeholder branding text when they're
 * absent (templates/vouchers/hotel_voucher.html guards every field with
 * {{#if}}, via the shared companyHeader partial for the branding block).
 */
class BookingVoucherPdfService {
  static async generatePdfBuffer({ voucherNumber, generatedAt, generatedBy, printedBy, company, customer, guest, client, booking, typeDetails, documentSettings, qrCodeDataUri }) {
    return renderHtmlToPdfBuffer(TEMPLATE_PATH, {
      voucherNumber,
      generatedAt,
      generatedBy,
      printedBy,
      company,
      customer,
      guest,
      client,
      booking,
      typeDetails,
      documentSettings,
      qrCodeDataUri
    });
  }
}

export default BookingVoucherPdfService;
