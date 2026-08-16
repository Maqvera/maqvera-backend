import PDFDocument from "pdfkit";

/**
 * Real PDF generation (`pdfkit`, the same dependency
 * services/InvoicePdfService.js and services/ReceiptPdfService.js already
 * use) — an actual credit note document referencing the original invoice,
 * not a placeholder.
 */
class CreditNotePdfService {
  static async generatePdfBuffer({ creditNumber, status, issuedAt, invoiceNumber, customerName, reason, currency, items, creditAmount, taxAdjustmentTotal, grandTotal, disposition }) {
    return new Promise((resolve, reject) => {
      const doc = new PDFDocument({ margin: 50, size: "A4" });
      const chunks = [];
      doc.on("data", (chunk) => chunks.push(chunk));
      doc.on("end", () => resolve(Buffer.concat(chunks)));
      doc.on("error", reject);

      doc.fontSize(20).text("CREDIT NOTE", { align: "center" });
      if (status === "Draft") doc.fontSize(10).fillColor("gray").text("DRAFT — NOT YET ISSUED", { align: "center" }).fillColor("black");
      doc.moveDown();

      doc.fontSize(10);
      doc.text(`Credit Note Number: ${creditNumber}`);
      doc.text(`Against Invoice: ${invoiceNumber}`);
      doc.text(`Date: ${new Date(issuedAt || Date.now()).toISOString().split("T")[0]}`);
      doc.text(`Customer: ${customerName}`);
      doc.text(`Reason: ${reason}`);
      doc.moveDown();

      doc.fontSize(11).text("Credited Items", { underline: true });
      doc.fontSize(9);
      items.forEach((item) => {
        doc.text(`${item.description} — Qty ${item.quantity} = ${item.amount.toLocaleString()} ${currency}` +
          (item.taxCode ? ` [${item.taxCode}: +${item.taxAdjustment.toLocaleString()}]` : "") +
          ` = ${item.lineTotal.toLocaleString()} ${currency}`);
      });
      doc.moveDown();

      doc.fontSize(10);
      doc.text(`Credit Amount: ${creditAmount.toLocaleString()} ${currency}`);
      if (taxAdjustmentTotal > 0) doc.text(`Tax Adjustment: +${taxAdjustmentTotal.toLocaleString()} ${currency}`);
      doc.fontSize(14).text(`Grand Total Credited: ${grandTotal.toLocaleString()} ${currency}`, { align: "left" });
      doc.fontSize(9).text(`Disposition: ${disposition === "Refund" ? "Refund Requested" : "Customer Credit Wallet"}`);

      doc.end();
    });
  }
}

export default CreditNotePdfService;
