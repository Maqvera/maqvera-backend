import BaseStatementParser from "./BaseStatementParser.js";

// Real OFX parsing via tag regex extraction — deliberately not a full
// SGML/XML parser, because OFX 1.x is SGML with tags that often have no
// closing tag on the same line (`<TRNTYPE>DEBIT` with no `</TRNTYPE>`),
// which a strict XML parser rejects outright; OFX 2.x IS well-formed XML,
// but this same tolerant regex approach reads both versions identically
// without needing to detect which one a given file is.
const extractTag = (block, tag) => {
  const match = block.match(new RegExp(`<${tag}>([^<\\r\\n]*)`, "i"));
  return match ? match[1].trim() : null;
};

// OFX dates: YYYYMMDD[HHMMSS][.XXX][[+/-]TZ] — only the date portion matters here.
const parseOfxDate = (value) => {
  if (!value) return null;
  const digits = value.replace(/[^0-9]/g, "").slice(0, 8);
  if (digits.length < 8) return null;
  const year = parseInt(digits.slice(0, 4), 10);
  const month = parseInt(digits.slice(4, 6), 10) - 1;
  const day = parseInt(digits.slice(6, 8), 10);
  const date = new Date(Date.UTC(year, month, day));
  return Number.isNaN(date.getTime()) ? null : date;
};

class OfxStatementParser extends BaseStatementParser {
  constructor() { super("OFX"); }

  async parse(buffer) {
    const text = buffer.toString("utf8");

    const currency = extractTag(text, "CURDEF");
    const ledgerBalance = extractTag(text, "BALAMT");
    const ledgerDate = extractTag(text, "DTASOF");

    const blocks = text.match(/<STMTTRN>[\s\S]*?(?=<STMTTRN>|<\/BANKTRANLIST>|<\/STMTTRN>)/gi) || [];
    const transactions = [];
    for (const block of blocks) {
      const amountStr = extractTag(block, "TRNAMT");
      const dateStr = extractTag(block, "DTPOSTED");
      if (amountStr === null || dateStr === null) continue;

      const rawAmount = parseFloat(amountStr);
      if (Number.isNaN(rawAmount) || rawAmount === 0) continue;
      const transactionDate = parseOfxDate(dateStr);
      if (!transactionDate) continue;

      transactions.push({
        externalTransactionId: extractTag(block, "FITID"),
        transactionDate,
        valueDate: null,
        direction: rawAmount >= 0 ? "Credit" : "Debit",
        amount: Math.abs(rawAmount),
        reference: extractTag(block, "NAME") || extractTag(block, "MEMO"),
        rawLine: block.trim()
      });
    }

    if (transactions.length === 0) throw new Error("No recognizable <STMTTRN> transactions found in the OFX file.");

    // OFX has no native "opening balance" concept — only a ledger balance
    // as of a date (BALAMT/DTASOF), treated as the closing balance; the
    // caller supplies openingBalance explicitly, same as CSV/Excel.
    return {
      openingBalance: null,
      closingBalance: ledgerBalance !== null ? parseFloat(ledgerBalance) : null,
      currency,
      statementDate: ledgerDate ? parseOfxDate(ledgerDate) : null,
      transactions
    };
  }
}

export default OfxStatementParser;
