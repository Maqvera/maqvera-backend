import PDFDocument from "pdfkit";

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

/**
 * Real PDF generation (the `pdfkit` npm package — pure JS, no external
 * service or credentials needed). Produces an actual PDF byte stream, not
 * a placeholder — the generated buffer is what's actually stored (see
 * utils/receiptPdfStorage.js) and served back to the caller.
 */
class ReceiptPdfService {
  // `company` (name/logoUrl/vatNumber/registrationNumber/address) — booking-
  // module PRD item B4, sourced from TenantProfileModel via
  // utils/tenantBranding.js. Optional: a tenant with no profile set up yet
  // still gets a valid receipt, just without a branding header.
  static async generatePdfBuffer({ receiptNumber, template, issueDate, amount, currency, paymentNumber, partyName, allocations = [], qrPngBuffer, company }) {
    return new Promise((resolve, reject) => {
      const doc = new PDFDocument({ margin: 50, size: "A4" });
      const chunks = [];
      doc.on("data", (chunk) => chunks.push(chunk));
      doc.on("end", () => resolve(Buffer.concat(chunks)));
      doc.on("error", reject);

      const title = TEMPLATE_TITLES[template] || TEMPLATE_TITLES.Default;

      if (company?.name) doc.fontSize(14).text(company.name, { align: "center" });
      if (company?.address) doc.fontSize(9).fillColor("gray").text(company.address, { align: "center" }).fillColor("black");
      doc.fontSize(20).text(title, { align: "center" });
      doc.moveDown();
      doc.fontSize(10).text(`Receipt Number: ${receiptNumber}`);
      if (company?.vatNumber) doc.text(`VAT Number: ${company.vatNumber}`);
      if (company?.registrationNumber) doc.text(`Registration Number: ${company.registrationNumber}`);
      doc.text(`Issue Date: ${new Date(issueDate).toISOString().split("T")[0]}`);
      doc.text(`Payment Number: ${paymentNumber}`);
      if (partyName) doc.text(`Issued To: ${partyName}`);
      doc.moveDown();

      doc.fontSize(14).text(`Amount: ${amount.toLocaleString()} ${currency}`, { align: "left" });
      doc.moveDown();

      if (allocations.length > 0) {
        doc.fontSize(11).text("Applied To:", { underline: true });
        doc.fontSize(10);
        allocations.forEach((allocation) => {
          doc.text(`${allocation.targetType} (${allocation.targetId}) — ${allocation.amount.toLocaleString()} ${currency}`);
        });
        doc.moveDown();
      }

      if (qrPngBuffer) {
        doc.text("Scan to verify:", { align: "left" });
        doc.image(qrPngBuffer, { width: 120 });
      }

      doc.end();
    });
  }
}

export default ReceiptPdfService;
