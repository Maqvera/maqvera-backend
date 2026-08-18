import PDFDocument from "pdfkit";

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

/**
 * Real PDF generation (the `pdfkit` npm package, same dependency
 * services/ReceiptPdfService.js already uses) — an actual itemized invoice
 * document, not a placeholder.
 */
class InvoicePdfService {
  // `company` (name/logoUrl/vatNumber/registrationNumber/address/phone/
  // email/bankDetails) is optional — booking-module PRD Part C item #15,
  // sourced from TenantProfileModel/BankAccountModel by the caller
  // (InvoiceService._generatePdf). Was previously absent from this PDF
  // entirely (confirmed by grep — no company/tenant/logo reference
  // anywhere in this file, not even a hardcoded one), so a tenant with no
  // profile set up yet still gets a valid invoice, just without a branding
  // header — never a fabricated placeholder company name.
  // `bookingDetails` (guestName/paxCount/hotels[]) — booking-module PRD item
  // A6, populated only when this invoice was generated from a booking (see
  // InvoiceService._resolveBookingDetailsForPdf). No pricing/tax logic is
  // computed here — those numbers already arrive fully computed in `items`/
  // `subtotal`/`taxTotal`/`grandTotal`; this file only renders them.
  static async generatePdfBuffer({ invoiceNumber, invoiceType, status, issueDate, dueDate, customerName, currency, items, subtotal, taxTotal, discountTotal, grandTotal, company, bookingDetails }) {
    return new Promise((resolve, reject) => {
      const doc = new PDFDocument({ margin: 50, size: "A4" });
      const chunks = [];
      doc.on("data", (chunk) => chunks.push(chunk));
      doc.on("end", () => resolve(Buffer.concat(chunks)));
      doc.on("error", reject);

      const title = TYPE_TITLES[invoiceType] || TYPE_TITLES.Custom;

      if (company?.name) doc.fontSize(14).text(company.name, { align: "center" });
      if (company?.address) doc.fontSize(9).fillColor("gray").text(company.address, { align: "center" }).fillColor("black");
      doc.fontSize(20).text(title, { align: "center" });
      if (status === "Draft") doc.fontSize(10).fillColor("gray").text("DRAFT — NOT YET ISSUED", { align: "center" }).fillColor("black");
      doc.moveDown();

      doc.fontSize(10);
      doc.text(`Invoice Number: ${invoiceNumber}`);
      if (company?.vatNumber) doc.text(`VAT Number: ${company.vatNumber}`);
      if (company?.registrationNumber) doc.text(`Registration Number: ${company.registrationNumber}`);
      doc.text(`Issue Date: ${new Date(issueDate).toISOString().split("T")[0]}`);
      doc.text(`Due Date: ${new Date(dueDate).toISOString().split("T")[0]}`);
      doc.text(`Bill To: ${customerName}`);
      if (bookingDetails?.guestName) doc.text(`Guest: ${bookingDetails.guestName}`);
      if (bookingDetails?.paxCount) doc.text(`PAX: ${bookingDetails.paxCount}`);
      doc.moveDown();

      if (Array.isArray(bookingDetails?.hotels) && bookingDetails.hotels.length > 0) {
        doc.fontSize(11).text("Hotel / Room Details", { underline: true });
        doc.fontSize(9);
        bookingDetails.hotels.forEach((h) => {
          const checkIn = h.checkIn ? new Date(h.checkIn).toISOString().split("T")[0] : "-";
          const checkOut = h.checkOut ? new Date(h.checkOut).toISOString().split("T")[0] : "-";
          const pax = [h.adultCount ? `${h.adultCount} Adult` : null, h.childCount ? `${h.childCount} Child` : null, h.infantCount ? `${h.infantCount} Infant` : null].filter(Boolean).join(", ");
          doc.text(`${h.hotelName}${h.hotelConfirmationNumber ? ` (CNF: ${h.hotelConfirmationNumber})` : ""}`);
          doc.text(`  Room: ${h.roomType || "-"}${h.view ? ` (${h.view})` : ""} | Check-In: ${checkIn} | Check-Out: ${checkOut} | Nights: ${h.nights}`);
          if (pax) doc.text(`  PAX: ${pax}`);
          if (h.mealPlan) doc.text(`  Meal Plan: ${h.mealPlan}`);
        });
        doc.moveDown();
      }

      doc.fontSize(11).text("Items", { underline: true });
      doc.fontSize(9);
      items.forEach((item) => {
        doc.text(`${item.description} — Qty ${item.quantity} x ${item.unitPrice.toLocaleString()} ${currency}` +
          (item.taxCode ? ` [${item.taxCode}: +${item.lineTaxAmount.toLocaleString()}]` : "") +
          (item.lineDiscountAmount > 0 ? ` [Discount: -${item.lineDiscountAmount.toLocaleString()}]` : "") +
          ` = ${item.lineTotal.toLocaleString()} ${currency}`);
      });
      doc.moveDown();

      doc.fontSize(10);
      doc.text(`Subtotal: ${subtotal.toLocaleString()} ${currency}`);
      if (discountTotal > 0) doc.text(`Discount: -${discountTotal.toLocaleString()} ${currency}`);
      if (taxTotal > 0) doc.text(`Tax: +${taxTotal.toLocaleString()} ${currency}`);
      doc.fontSize(14).text(`Grand Total: ${grandTotal.toLocaleString()} ${currency}`, { align: "left" });

      if (company?.bankDetails) {
        doc.moveDown();
        doc.fontSize(11).text("Payment Details", { underline: true });
        doc.fontSize(9);
        if (company.bankDetails.bankName) doc.text(`Bank Name: ${company.bankDetails.bankName}`);
        if (company.bankDetails.accountName) doc.text(`Account Name: ${company.bankDetails.accountName}`);
        if (company.bankDetails.iban) doc.text(`IBAN: ${company.bankDetails.iban}`);
        if (company.bankDetails.swiftCode) doc.text(`SWIFT/BIC: ${company.bankDetails.swiftCode}`);
        if (company.bankDetails.accountNumberLast4) doc.text(`Account: ****${company.bankDetails.accountNumberLast4}`);
      }

      doc.end();
    });
  }
}

export default InvoicePdfService;
