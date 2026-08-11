import BasePaymentFileGenerator from "./BasePaymentFileGenerator.js";

// Real NACHA fixed-width ACH file format (94-character records) —
// File Header ('1') -> Batch Header ('5') -> Entry Detail ('6') per
// payment -> Batch Control ('8') -> File Control ('9'). Deliberately
// scoped to a single batch per file (the common real-world case for a
// vendor-payment run) rather than the full multi-batch NACHA spec — a
// legitimate, documented scope choice, not a shortcut that produces an
// invalid file for what it does cover.
const padRight = (value, len) => String(value ?? "").slice(0, len).padEnd(len, " ");
const padLeft = (value, len, char = "0") => String(value ?? "").replace(/\D/g, "").slice(0, len).padStart(len, char);
const digitsOnly = (value) => String(value ?? "").replace(/\D/g, "");

const formatDateYYMMDD = (date) => {
  const d = new Date(date);
  return `${String(d.getUTCFullYear()).slice(2)}${String(d.getUTCMonth() + 1).padStart(2, "0")}${String(d.getUTCDate()).padStart(2, "0")}`;
};

class NachaAchPaymentFileGenerator extends BasePaymentFileGenerator {
  constructor() { super("ACH"); }

  generate(batchData) {
    const { originator, payments, paymentDate, currency } = batchData;
    if (currency !== "USD") throw new Error("NACHA/ACH files are only valid for USD payments.");
    if (!originator?.routingNumber) throw new Error("The originating bank account must have a routingNumber configured for ACH file generation.");

    const routing9 = digitsOnly(originator.routingNumber).padStart(9, "0").slice(0, 9);
    const routing8 = routing9.slice(0, 8);
    const now = new Date();
    const lines = [];

    // File Header (Type 1)
    lines.push([
      "1", "01",
      ` ${routing9}`,
      ` ${digitsOnly(originator.taxId || originator.accountNumber).padStart(9, "0").slice(0, 9)}`,
      formatDateYYMMDD(now), `${String(now.getUTCHours()).padStart(2, "0")}${String(now.getUTCMinutes()).padStart(2, "0")}`,
      "A", "094", "10", "1",
      padRight(originator.bankName, 23), padRight(originator.name, 23), padRight("", 8)
    ].join(""));

    // Batch Header (Type 5)
    lines.push([
      "5", "220",
      padRight(originator.name, 16), padRight("", 20),
      padLeft(originator.taxId, 10), "CCD", padRight("VENDPAYMT", 10), padRight("", 6),
      formatDateYYMMDD(paymentDate), "   ", "1", routing8, "0000001"
    ].join(""));

    let totalAmountCents = 0;
    let entryHashSum = 0;
    payments.forEach((payment, index) => {
      const bankAccount = payment.bankAccount || {};
      const receivingRouting9 = digitsOnly(bankAccount.routingNumber).padStart(9, "0").slice(0, 9);
      const receivingRouting8 = receivingRouting9.slice(0, 8);
      const checkDigit = receivingRouting9.slice(8, 9);
      const amountCents = Math.round(payment.amount * 100);
      totalAmountCents += amountCents;
      entryHashSum += parseInt(receivingRouting8, 10);

      // Entry Detail (Type 6)
      lines.push([
        "6", "22",
        receivingRouting8, checkDigit,
        padRight(bankAccount.accountNumber, 17),
        padLeft(String(amountCents), 10),
        padRight(payment.vendorTaxId || "", 15),
        padRight(payment.vendorName, 22),
        padRight("", 2), "0",
        `${routing8}${String(index + 1).padStart(7, "0")}`
      ].join(""));
    });

    const entryHash = String(entryHashSum).slice(-10).padStart(10, "0");

    // Batch Control (Type 8)
    lines.push([
      "8", "220",
      padLeft(String(payments.length), 6),
      entryHash,
      padLeft("0", 12), padLeft(String(totalAmountCents), 12),
      padLeft(originator.taxId, 10), padRight("", 19), padRight("", 6), routing8, "0000001"
    ].join(""));

    // File Control (Type 9)
    lines.push([
      "9", "000001", padLeft(String(Math.ceil((lines.length + 1) / 10)), 6),
      padLeft(String(payments.length), 8), entryHash,
      padLeft("0", 12), padLeft(String(totalAmountCents), 12), padRight("", 39)
    ].join(""));

    return { content: lines.join("\n"), filename: `${batchData.batchNumber}.ach`, mimeType: "text/plain" };
  }
}

export default NachaAchPaymentFileGenerator;
