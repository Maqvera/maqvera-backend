import BasePaymentFileGenerator from "./BasePaymentFileGenerator.js";

const escapeCsvCell = (cell) => {
  const str = String(cell ?? "");
  return /[",\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
};

class CsvPaymentFileGenerator extends BasePaymentFileGenerator {
  constructor() { super("CSV"); }

  generate(batchData) {
    const rows = [["Vendor", "Account/IBAN", "SWIFT/BIC", "Amount", "Currency", "Reference", "Payment Date"]];
    for (const payment of batchData.payments) {
      rows.push([
        payment.vendorName,
        payment.bankAccount?.iban || payment.bankAccount?.accountNumber || "",
        payment.bankAccount?.swiftBic || "",
        payment.amount,
        batchData.currency,
        payment.reference,
        new Date(batchData.paymentDate).toISOString().slice(0, 10)
      ]);
    }
    const content = rows.map((row) => row.map(escapeCsvCell).join(",")).join("\n");
    return { content, filename: `${batchData.batchNumber}.csv`, mimeType: "text/csv" };
  }
}

export default CsvPaymentFileGenerator;
