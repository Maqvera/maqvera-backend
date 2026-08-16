import { XMLBuilder } from "fast-xml-parser";
import BasePaymentFileGenerator from "./BasePaymentFileGenerator.js";

// Real ISO 20022 pain.001.001.03 (CustomerCreditTransferInitiation) XML —
// what "SEPA Credit Transfer" actually is (a specific European usage of
// this same generic ISO 20022 message), so this one generator honestly
// serves both the "SEPA" and "ISO 20022" configured format values rather
// than being two parallel near-duplicate implementations.
const roundCurrency = (value) => Math.round((Number(value) || 0) * 100) / 100;

class SepaPaymentFileGenerator extends BasePaymentFileGenerator {
  constructor() { super("SEPA"); }

  generate(batchData) {
    const { originator, payments, paymentDate, currency, batchNumber } = batchData;
    if (!originator?.iban) throw new Error("The originating bank account must have an IBAN configured for SEPA/ISO 20022 file generation.");

    const totalAmount = roundCurrency(payments.reduce((sum, p) => sum + p.amount, 0));
    const now = new Date().toISOString();

    const document = {
      Document: {
        "@_xmlns": "urn:iso:std:iso:20022:tech:xsd:pain.001.001.03",
        CstmrCdtTrfInitn: {
          GrpHdr: {
            MsgId: batchNumber,
            CreDtTm: now,
            NbOfTxs: payments.length,
            CtrlSum: totalAmount.toFixed(2),
            InitgPty: { Nm: originator.name }
          },
          PmtInf: {
            PmtInfId: `${batchNumber}-PMT`,
            PmtMtd: "TRF",
            NbOfTxs: payments.length,
            CtrlSum: totalAmount.toFixed(2),
            ReqdExctnDt: new Date(paymentDate).toISOString().slice(0, 10),
            Dbtr: { Nm: originator.name },
            DbtrAcct: { Id: { IBAN: originator.iban } },
            DbtrAgt: { FinInstnId: { BICFI: originator.swiftBic || "NOTPROVIDED" } },
            CdtTrfTxInf: payments.map((payment, index) => ({
              PmtId: { EndToEndId: payment.reference || `${batchNumber}-${index + 1}` },
              Amt: { InstdAmt: { "@_Ccy": currency, "#text": roundCurrency(payment.amount).toFixed(2) } },
              CdtrAgt: { FinInstnId: { BICFI: payment.bankAccount?.swiftBic || "NOTPROVIDED" } },
              Cdtr: { Nm: payment.vendorName },
              CdtrAcct: { Id: { IBAN: payment.bankAccount?.iban } },
              RmtInf: { Ustrd: payment.reference || "" }
            }))
          }
        }
      }
    };

    const builder = new XMLBuilder({ format: true, ignoreAttributes: false, attributeNamePrefix: "@_" });
    const xml = `<?xml version="1.0" encoding="UTF-8"?>\n${builder.build(document)}`;

    return { content: xml, filename: `${batchNumber}.xml`, mimeType: "application/xml" };
  }
}

export default SepaPaymentFileGenerator;
