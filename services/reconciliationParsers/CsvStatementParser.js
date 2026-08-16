import { parse } from "csv-parse/sync";
import BaseStatementParser from "./BaseStatementParser.js";
import { mapRowToTransaction } from "./rowMapping.js";

/** Real CSV parsing (`csv-parse`) — no opening/closing balance/currency of its own; the caller must supply those (see BankReconciliationService.importStatement). */
class CsvStatementParser extends BaseStatementParser {
  constructor() { super("CSV"); }

  async parse(buffer) {
    let records;
    try {
      records = parse(buffer.toString("utf8"), { columns: true, skip_empty_lines: true, trim: true, bom: true });
    } catch (error) {
      throw new Error(`Failed to parse CSV file: ${error.message}`);
    }

    const transactions = records.map(mapRowToTransaction).filter(Boolean);
    if (transactions.length === 0) throw new Error("No recognizable transactions found in the CSV file (expected a date column plus an amount or debit/credit column).");

    return { openingBalance: null, closingBalance: null, currency: null, statementDate: null, transactions };
  }
}

export default CsvStatementParser;
