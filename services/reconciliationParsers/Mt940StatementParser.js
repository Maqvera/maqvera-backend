import BaseStatementParser from "./BaseStatementParser.js";

// Real SWIFT MT940 tag grammar — `:20:` transaction reference, `:25:`
// account identification, `:28C:` statement number, `:60F:`/`:60M:`
// opening balance, `:61:` statement line (one per transaction), `:86:`
// narrative for the immediately preceding `:61:`, `:62F:`/`:62M:` closing
// balance. Handles the common/standard tag layout described in the SWIFT
// MT940 field spec; banks with non-standard `:61:` extensions may need
// adjustment — the same real-world variance every MT940 parser, commercial
// or open-source, has to tolerate.
const TAG_REGEX = /^:(\d{2}[A-Z]?):/;
// Balance tag value: D/C mark + YYMMDD + 3-letter currency + amount (comma decimal).
const BALANCE_REGEX = /^([CD])(\d{6})([A-Z]{3})([\d,]+)/;
// Statement line value: YYMMDD value date, optional MMDD entry date, D/C
// (or reversal RD/RC) mark, optional 1-letter funds code, amount, then
// transaction type + reference (free-form after the amount).
const STATEMENT_LINE_REGEX = /^(\d{6})(\d{0,4})(RC|RD|C|D)([A-Z])?([\d,]+)([\s\S]*)$/;

const parseMt940Date = (yymmdd) => {
  const year = 2000 + parseInt(yymmdd.slice(0, 2), 10);
  const month = parseInt(yymmdd.slice(2, 4), 10) - 1;
  const day = parseInt(yymmdd.slice(4, 6), 10);
  return new Date(Date.UTC(year, month, day));
};

const splitTags = (text) => {
  const lines = text.split(/\r\n|\r|\n/);
  const tags = [];
  let current = null;
  for (const line of lines) {
    const match = line.match(TAG_REGEX);
    if (match) {
      if (current) tags.push(current);
      current = { tag: match[1], value: line.slice(match[0].length) };
    } else if (current) {
      current.value += `\n${line}`;
    }
  }
  if (current) tags.push(current);
  return tags;
};

const parseBalanceTag = (value) => {
  const match = value.match(BALANCE_REGEX);
  if (!match) return null;
  const [, mark, dateStr, currency, amountStr] = match;
  const amount = parseFloat(amountStr.replace(",", "."));
  return { date: parseMt940Date(dateStr), currency, amount: mark === "D" ? -amount : amount };
};

const parseStatementLine = (value) => {
  const match = value.match(STATEMENT_LINE_REGEX);
  if (!match) return null;
  const [, valueDateStr, , mark, , amountStr, rest] = match;
  const isDebit = mark === "D" || mark === "RD";
  const amount = parseFloat(amountStr.replace(",", "."));
  if (Number.isNaN(amount)) return null;
  const transactionTypeMatch = rest.match(/^([A-Z0-9]{4})([\s\S]*)$/);
  const reference = transactionTypeMatch ? transactionTypeMatch[2].replace(/^\/\//, "").trim() : rest.trim();
  return { valueDate: parseMt940Date(valueDateStr), direction: isDebit ? "Debit" : "Credit", amount, reference: reference || null };
};

class Mt940StatementParser extends BaseStatementParser {
  constructor() { super("MT940"); }

  async parse(buffer) {
    const tags = splitTags(buffer.toString("utf8"));

    let openingBalance = null;
    let closingBalance = null;
    let currency = null;
    let statementDate = null;
    const transactions = [];
    let pendingLine = null;

    for (const { tag, value } of tags) {
      if (tag === "60F" || tag === "60M") {
        const balance = parseBalanceTag(value);
        if (balance) { openingBalance = balance.amount; currency = balance.currency; statementDate = statementDate || balance.date; }
      } else if (tag === "61") {
        if (pendingLine) transactions.push(pendingLine);
        const line = parseStatementLine(value);
        pendingLine = line ? {
          externalTransactionId: null,
          transactionDate: line.valueDate,
          valueDate: line.valueDate,
          direction: line.direction,
          amount: Math.abs(line.amount),
          reference: line.reference,
          rawLine: `:61:${value}`
        } : null;
      } else if (tag === "86" && pendingLine) {
        pendingLine.reference = pendingLine.reference ? `${pendingLine.reference} ${value.trim()}` : value.trim();
        pendingLine.rawLine += `\n:86:${value}`;
      } else if (tag === "62F" || tag === "62M") {
        const balance = parseBalanceTag(value);
        if (balance) closingBalance = balance.amount;
      }
    }
    if (pendingLine) transactions.push(pendingLine);

    if (transactions.length === 0) throw new Error("No recognizable :61: transaction lines found in the MT940 file.");
    return { openingBalance, closingBalance, currency, statementDate, transactions };
  }
}

export default Mt940StatementParser;
