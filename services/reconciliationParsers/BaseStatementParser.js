/**
 * Base Bank Statement Parser Interface — Finance Module Part 14. Mirrors
 * services/gateways/BaseGatewayAdapter.js's own pattern for the identical
 * reason: every real format parser implements the same contract, so
 * BankReconciliationService never depends on a specific format's shape.
 *
 * `parse(buffer)` must return:
 * {
 *   openingBalance: number|null,
 *   closingBalance: number|null,
 *   currency: string|null,
 *   statementDate: Date|null,
 *   transactions: [{
 *     externalTransactionId: string|null,
 *     transactionDate: Date,
 *     valueDate: Date|null,
 *     direction: "Credit"|"Debit",
 *     amount: number,
 *     reference: string|null,
 *     rawLine: string
 *   }]
 * }
 */
class BaseStatementParser {
  constructor(formatName) {
    this.formatName = formatName;
  }

  /** @param {Buffer} _buffer */
  async parse(_buffer) {
    throw new Error(`parse() not implemented for format ${this.formatName}`);
  }
}

export default BaseStatementParser;
