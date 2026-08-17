import CsvPaymentFileGenerator from "./CsvPaymentFileGenerator.js";
import NachaAchPaymentFileGenerator from "./NachaAchPaymentFileGenerator.js";
import SepaPaymentFileGenerator from "./SepaPaymentFileGenerator.js";
import SwiftMtPaymentFileGenerator from "./SwiftMtPaymentFileGenerator.js";

// Mirrors services/reconciliationParsers/index.js's exact registry
// pattern, in the mirror-opposite direction (generating a real payment
// file instead of parsing a real statement). "SEPA" and "ISO 20022" share
// the same real pain.001 generator — see SepaPaymentFileGenerator.js's own
// doc comment for why that's one implementation, not two.
const GENERATORS = {
  CSV: new CsvPaymentFileGenerator(),
  ACH: new NachaAchPaymentFileGenerator(),
  SEPA: new SepaPaymentFileGenerator(),
  "ISO 20022": new SepaPaymentFileGenerator(),
  "SWIFT MT": new SwiftMtPaymentFileGenerator()
};

/** Returns the generator for `format`, or null if not supported. */
export const getPaymentFileGenerator = (format) => GENERATORS[format] || null;

export default getPaymentFileGenerator;
