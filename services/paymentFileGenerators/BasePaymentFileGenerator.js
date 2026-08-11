/**
 * Base Payment File Generator Interface — Finance Module Part 17. Mirrors
 * services/reconciliationParsers/BaseStatementParser.js's own pattern, in
 * the mirror-opposite direction: generating a real bank payment file
 * instead of parsing one. Every format generator implements the same
 * contract, so VendorPaymentService never depends on a specific format's
 * shape.
 *
 * `generate(batchData)` receives:
 * {
 *   batchNumber: string,
 *   paymentDate: Date,
 *   currency: string,
 *   originator: { name, taxId, routingNumber, accountNumber, iban, swiftBic, bankName },
 *   payments: [{ vendorName, vendorTaxId, amount, reference, bankAccount: { accountNumber, routingNumber, iban, swiftBic, bankName, country } }]
 * }
 * and returns { content: string, filename: string, mimeType: string }.
 */
class BasePaymentFileGenerator {
  constructor(formatName) {
    this.formatName = formatName;
  }

  /** @param {object} _batchData */
  generate(_batchData) {
    throw new Error(`generate() not implemented for format ${this.formatName}`);
  }
}

export default BasePaymentFileGenerator;
