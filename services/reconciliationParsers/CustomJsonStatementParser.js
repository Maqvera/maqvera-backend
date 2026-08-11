import BaseStatementParser from "./BaseStatementParser.js";

/**
 * "Custom Parser" — accepts a tenant-pre-shaped JSON transaction array
 * directly (their own export tooling has already converted a proprietary
 * bank format into this canonical shape), rather than this codebase
 * guessing at an arbitrary, undocumented bank export format.
 */
class CustomJsonStatementParser extends BaseStatementParser {
  constructor() { super("Custom"); }

  async parse(buffer) {
    let payload;
    try {
      payload = JSON.parse(buffer.toString("utf8"));
    } catch {
      throw new Error("Custom format file must be valid JSON.");
    }

    const rawTransactions = Array.isArray(payload) ? payload : payload.transactions;
    if (!Array.isArray(rawTransactions) || rawTransactions.length === 0) {
      throw new Error('Custom format JSON must be an array of transactions, or an object with a "transactions" array.');
    }

    const transactions = rawTransactions.map((t, index) => {
      if (!t.transactionDate || !t.direction || !t.amount) {
        throw new Error(`Custom transaction at index ${index} is missing transactionDate, direction, or amount.`);
      }
      if (!["Credit", "Debit"].includes(t.direction)) {
        throw new Error(`Custom transaction at index ${index} has an invalid direction "${t.direction}" (must be "Credit" or "Debit").`);
      }
      const transactionDate = new Date(t.transactionDate);
      if (Number.isNaN(transactionDate.getTime())) throw new Error(`Custom transaction at index ${index} has an invalid transactionDate.`);

      return {
        externalTransactionId: t.externalTransactionId || null,
        transactionDate,
        valueDate: t.valueDate ? new Date(t.valueDate) : null,
        direction: t.direction,
        amount: Math.abs(Number(t.amount)),
        reference: t.reference || null,
        rawLine: JSON.stringify(t)
      };
    });

    return {
      openingBalance: payload.openingBalance ?? null,
      closingBalance: payload.closingBalance ?? null,
      currency: payload.currency ?? null,
      statementDate: payload.statementDate ? new Date(payload.statementDate) : null,
      transactions
    };
  }
}

export default CustomJsonStatementParser;
