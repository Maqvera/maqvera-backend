import PDFDocument from "pdfkit";

/**
 * Real PDF generation (`pdfkit`, same dependency as
 * services/CreditNotePdfService.js) — party-aware: labels the counterparty
 * row "Customer"/"Vendor" and the reference row "Against Invoice"/"Against
 * Payable" depending on partyType, since a Debit Note can target either.
 */
class DebitNotePdfService {
  static async generatePdfBuffer({ debitNumber, status, issuedAt, partyType, invoiceNumber, customerName, vendorName, reason, currency, items, debitAmount, taxAdjustmentTotal, grandTotal }) {
    return new Promise((resolve, reject) => {
      const doc = new PDFDocument({ margin: 50, size: "A4" });
      const chunks = [];
      doc.on("data", (chunk) => chunks.push(chunk));
      doc.on("end", () => resolve(Buffer.concat(chunks)));
      doc.on("error", reject);

      doc.fontSize(20).text("DEBIT NOTE", { align: "center" });
      if (status === "Draft") doc.fontSize(10).fillColor("gray").text("DRAFT — NOT YET ISSUED", { align: "center" }).fillColor("black");
      doc.moveDown();

      doc.fontSize(10);
      doc.text(`Debit Note Number: ${debitNumber}`);
      doc.text(`${partyType === "Vendor" ? "Against Payable" : "Against Invoice"}: ${invoiceNumber}`);
      doc.text(`Date: ${new Date(issuedAt || Date.now()).toISOString().split("T")[0]}`);
      doc.text(`${partyType === "Vendor" ? "Vendor" : "Customer"}: ${partyType === "Vendor" ? vendorName : customerName}`);
      doc.text(`Reason: ${reason}`);
      doc.moveDown();

      doc.fontSize(11).text("Debited Items", { underline: true });
      doc.fontSize(9);
      items.forEach((item) => {
        doc.text(`${item.description} = ${item.amount.toLocaleString()} ${currency}` +
          (item.taxCode ? ` [${item.taxCode}: +${item.taxAdjustment.toLocaleString()}]` : "") +
          ` = ${item.lineTotal.toLocaleString()} ${currency}`);
      });
      doc.moveDown();

      doc.fontSize(10);
      doc.text(`Debit Amount: ${debitAmount.toLocaleString()} ${currency}`);
      if (taxAdjustmentTotal > 0) doc.text(`Tax Adjustment: +${taxAdjustmentTotal.toLocaleString()} ${currency}`);
      doc.fontSize(14).text(`Grand Total Debited: ${grandTotal.toLocaleString()} ${currency}`, { align: "left" });
      doc.fontSize(9).text(`This document increases the outstanding balance of the referenced ${partyType === "Vendor" ? "payable" : "invoice"}.`);

      doc.end();
    });
  }
}

export default DebitNotePdfService;
