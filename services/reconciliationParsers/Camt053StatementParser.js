import { XMLParser } from "fast-xml-parser";
import BaseStatementParser from "./BaseStatementParser.js";

// Real ISO 20022 camt.053 (BankToCustomerStatement) parsing —
// `Document/BkToCstmrStmt/Stmt/Bal` for opening/closing balances (`Tp/CdOrPrtry/Cd`
// of "OPBD"/"CLBD", falling back to the "available" variants "OPAV"/"CLAV"
// if booked balances aren't present) and `Stmt/Ntry` for each transaction
// entry (`CdtDbtInd`, `Amt`, `BookgDt`/`ValDt`, `NtryRef`, `AddtlNtryInf`).
const parserOptions = { ignoreAttributes: false, attributeNamePrefix: "@_" };

const asArray = (value) => (value === undefined || value === null ? [] : Array.isArray(value) ? value : [value]);
const amountOf = (node) => parseFloat(typeof node === "object" ? node?.["#text"] : node);
const currencyOf = (node) => (typeof node === "object" ? node?.["@_Ccy"] : null) || null;
const dateOf = (node) => node?.Dt || node?.DtTm || null;

class Camt053StatementParser extends BaseStatementParser {
  constructor() { super("CAMT.053"); }

  async parse(buffer) {
    let xml;
    try {
      xml = new XMLParser(parserOptions).parse(buffer.toString("utf8"));
    } catch (error) {
      throw new Error(`Failed to parse CAMT.053 file: ${error.message}`);
    }

    const stmt = xml?.Document?.BkToCstmrStmt?.Stmt;
    if (!stmt) throw new Error("File does not look like a valid CAMT.053 statement (no Document/BkToCstmrStmt/Stmt).");

    let openingBalance = null;
    let closingBalance = null;
    let currency = null;
    let statementDate = null;

    for (const bal of asArray(stmt.Bal)) {
      const code = bal?.Tp?.CdOrPrtry?.Cd;
      const amount = amountOf(bal?.Amt);
      if (Number.isNaN(amount)) continue;
      const signedAmount = bal?.CdtDbtInd === "DBIT" ? -amount : amount;
      const dateStr = dateOf(bal?.Dt);

      if (code === "OPBD" || (code === "OPAV" && openingBalance === null)) {
        openingBalance = signedAmount;
        currency = currency || currencyOf(bal?.Amt);
        if (dateStr) statementDate = statementDate || new Date(dateStr);
      }
      if (code === "CLBD" || (code === "CLAV" && closingBalance === null)) {
        closingBalance = signedAmount;
        currency = currency || currencyOf(bal?.Amt);
      }
    }

    const transactions = [];
    for (const entry of asArray(stmt.Ntry)) {
      const amount = amountOf(entry?.Amt);
      if (Number.isNaN(amount)) continue;
      const bookDateStr = dateOf(entry?.BookgDt) || dateOf(entry?.ValDt);
      const transactionDate = bookDateStr ? new Date(bookDateStr) : null;
      if (!transactionDate || Number.isNaN(transactionDate.getTime())) continue;
      const valueDateStr = dateOf(entry?.ValDt);

      transactions.push({
        externalTransactionId: entry?.NtryRef || entry?.AcctSvcrRef || null,
        transactionDate,
        valueDate: valueDateStr ? new Date(valueDateStr) : null,
        direction: entry?.CdtDbtInd === "DBIT" ? "Debit" : "Credit",
        amount,
        reference: entry?.AddtlNtryInf || entry?.NtryDtls?.TxDtls?.RmtInf?.Ustrd || null,
        rawLine: JSON.stringify(entry)
      });
    }

    if (transactions.length === 0) throw new Error("No recognizable <Ntry> transaction entries found in the CAMT.053 file.");
    return { openingBalance, closingBalance, currency, statementDate, transactions };
  }
}

export default Camt053StatementParser;
