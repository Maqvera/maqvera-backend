import ExcelJS from "exceljs";
import BaseStatementParser from "./BaseStatementParser.js";
import { mapRowToTransaction } from "./rowMapping.js";

// exceljs cell values can be a Date, number, plain string, or a rich object
// (formula result `{result}`, styled text `{richText}`) — this flattens
// each to the primitive mapRowToTransaction expects.
const flattenCellValue = (value) => {
  if (value === null || value === undefined || value instanceof Date) return value;
  if (typeof value === "object") {
    if (Array.isArray(value.richText)) return value.richText.map((t) => t.text).join("");
    if (value.result !== undefined) return value.result;
    if (value.text !== undefined) return value.text;
  }
  return value;
};

/** Real .xlsx parsing (`exceljs`) — reads the first worksheet's header row, then maps each subsequent row the same way CsvStatementParser does. */
class ExcelStatementParser extends BaseStatementParser {
  constructor() { super("Excel"); }

  async parse(buffer) {
    const workbook = new ExcelJS.Workbook();
    try {
      await workbook.xlsx.load(buffer);
    } catch (error) {
      throw new Error(`Failed to parse Excel file: ${error.message}`);
    }

    const worksheet = workbook.worksheets[0];
    if (!worksheet) throw new Error("Excel file has no worksheets.");

    const headerValues = worksheet.getRow(1).values;
    const headers = (Array.isArray(headerValues) ? headerValues.slice(1) : []).map((h) => String(flattenCellValue(h) || "").trim());

    const transactions = [];
    worksheet.eachRow((row, rowNumber) => {
      if (rowNumber === 1) return;
      const values = (Array.isArray(row.values) ? row.values.slice(1) : []).map(flattenCellValue);
      const record = {};
      headers.forEach((header, index) => { if (header) record[header] = values[index]; });
      const txn = mapRowToTransaction(record);
      if (txn) transactions.push(txn);
    });

    if (transactions.length === 0) throw new Error("No recognizable transactions found in the Excel file (expected a date column plus an amount or debit/credit column).");

    return { openingBalance: null, closingBalance: null, currency: null, statementDate: null, transactions };
  }
}

export default ExcelStatementParser;
