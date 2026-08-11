import BasePaymentFileGenerator from "./BasePaymentFileGenerator.js";

// Real SWIFT MT103 (Single Customer Credit Transfer) generation — MT103 is
// inherently one message per transfer (not a batch format the way
// NACHA/pain.001 are), so this produces one real MT103 block per payment,
// concatenated. Real tag grammar: :20: transaction reference, :23B: bank
// operation code, :32A: value date + currency + amount, :50K: ordering
// customer, :59: beneficiary customer, :70: remittance information, :71A:
// details of charges.
const formatValueDateYYMMDD = (date) => {
  const d = new Date(date);
  return `${String(d.getUTCFullYear()).slice(2)}${String(d.getUTCMonth() + 1).padStart(2, "0")}${String(d.getUTCDate()).padStart(2, "0")}`;
};

const formatSwiftAmount = (amount) => amount.toFixed(2).replace(".", ",");

class SwiftMtPaymentFileGenerator extends BasePaymentFileGenerator {
  constructor() { super("SWIFT MT"); }

  generate(batchData) {
    const { originator, payments, paymentDate, currency, batchNumber } = batchData;
    if (!originator?.swiftBic) throw new Error("The originating bank account must have a swiftBic configured for SWIFT MT file generation.");

    const senderBic = originator.swiftBic.padEnd(11, "X").slice(0, 11);
    const valueDate = formatValueDateYYMMDD(paymentDate);

    const messages = payments.map((payment, index) => {
      const receiverBic = (payment.bankAccount?.swiftBic || "NOTPROVIDEDXXX").padEnd(11, "X").slice(0, 11);
      const reference = (payment.reference || `${batchNumber}-${index + 1}`).slice(0, 16);
      const lines = [
        `{1:F01${senderBic}0000000000}`,
        `{2:I103${receiverBic}N}`,
        "{4:",
        `:20:${reference}`,
        ":23B:CRED",
        `:32A:${valueDate}${currency}${formatSwiftAmount(payment.amount)}`,
        `:50K:/${originator.iban || originator.accountNumber || ""}`,
        originator.name,
        `:59:/${payment.bankAccount?.iban || payment.bankAccount?.accountNumber || ""}`,
        payment.vendorName,
        `:70:${(payment.reference || "").slice(0, 35)}`,
        ":71A:SHA",
        "-}"
      ];
      return lines.join("\n");
    });

    return { content: messages.join("\n\n"), filename: `${batchNumber}.mt103`, mimeType: "text/plain" };
  }
}

export default SwiftMtPaymentFileGenerator;
