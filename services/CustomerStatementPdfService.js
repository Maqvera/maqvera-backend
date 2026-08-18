import PDFDocument from "pdfkit";

/**
 * Customer Account Statement PDF (booking-module PRD Part A item #6).
 * Same `pdfkit` dependency and generate-buffer-then-return shape as
 * services/InvoicePdfService.js — populated entirely from
 * CustomerAccountStatementService.getStatement()'s live data, never a
 * separately-maintained template with its own totals.
 */
class CustomerStatementPdfService {
  static async generatePdfBuffer(statement) {
    return new Promise((resolve, reject) => {
      const doc = new PDFDocument({ margin: 50, size: "A4" });
      const chunks = [];
      doc.on("data", (chunk) => chunks.push(chunk));
      doc.on("end", () => resolve(Buffer.concat(chunks)));
      doc.on("error", reject);

      const currency = statement.rows[0]?.currency || "USD";

      doc.fontSize(20).text("CUSTOMER ACCOUNT STATEMENT", { align: "center" });
      doc.moveDown();

      doc.fontSize(10);
      doc.text(`Customer: ${statement.customer.name}`);
      if (statement.customer.customerCode) doc.text(`Customer Code: ${statement.customer.customerCode}`);
      if (statement.period.dateFrom || statement.period.dateTo) {
        doc.text(`Period: ${statement.period.dateFrom || "Inception"} to ${statement.period.dateTo || "Present"}`);
      }
      doc.text(`Generated: ${new Date(statement.generatedAt).toISOString().split("T")[0]}`);
      doc.moveDown();

      doc.fontSize(11).text("Statement Rows", { underline: true });
      doc.fontSize(9);
      statement.rows.forEach((row) => {
        doc.text(
          `${row.referenceNumber} — ${row.description} | ` +
          `Debit: ${row.debit.toLocaleString()} ${row.currency} | ` +
          `Credit: ${row.credit.toLocaleString()} ${row.currency} | ` +
          `Balance: ${row.balance.toLocaleString()} ${row.currency} | ${row.status}`
        );
      });
      doc.moveDown();

      doc.fontSize(10);
      doc.text(`Total Debit: ${statement.totals.totalDebit.toLocaleString()} ${currency}`);
      doc.text(`Total Credit: ${statement.totals.totalCredit.toLocaleString()} ${currency}`);
      doc.fontSize(14).text(`Outstanding Balance: ${statement.totals.totalBalance.toLocaleString()} ${currency}`, { align: "left" });

      doc.end();
    });
  }
}

export default CustomerStatementPdfService;
