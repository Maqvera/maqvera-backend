// Shared column-detection logic for the two spreadsheet-shaped formats
// (CSV, Excel) — real bank exports vary in header wording, so this
// recognizes a reasonable set of common aliases rather than requiring one
// exact schema. Not used by MT940/CAMT.053/OFX, which carry their own
// real structured grammar instead of a header row.
const DATE_HEADERS = ["date", "transaction date", "txn date", "posting date", "value date", "trans date"];
const REFERENCE_HEADERS = ["description", "narrative", "reference", "particulars", "details", "remarks", "memo"];
const AMOUNT_HEADERS = ["amount", "amt"];
const DEBIT_HEADERS = ["debit", "withdrawal", "dr", "debit amount"];
const CREDIT_HEADERS = ["credit", "deposit", "cr", "credit amount"];
const EXTERNAL_ID_HEADERS = ["transaction id", "reference no", "cheque no", "ref no", "id", "txn id"];

const findHeader = (headers, candidates) => headers.find((h) => candidates.includes(String(h).trim().toLowerCase()));

const parseAmount = (value) => {
  if (value === null || value === undefined || value === "") return NaN;
  return parseFloat(String(value).replace(/,/g, ""));
};

/**
 * Maps one already-parsed row object (`{header: value}`) into the common
 * transaction shape, or returns null when the row isn't a real transaction
 * line (blank row, summary/total row, unrecognized shape).
 */
export const mapRowToTransaction = (row) => {
  const headers = Object.keys(row);
  const dateHeader = findHeader(headers, DATE_HEADERS);
  const referenceHeader = findHeader(headers, REFERENCE_HEADERS);
  const amountHeader = findHeader(headers, AMOUNT_HEADERS);
  const debitHeader = findHeader(headers, DEBIT_HEADERS);
  const creditHeader = findHeader(headers, CREDIT_HEADERS);
  const externalIdHeader = findHeader(headers, EXTERNAL_ID_HEADERS);

  if (!dateHeader) return null;

  let amount = null;
  let direction = null;
  if (amountHeader && row[amountHeader] !== undefined && row[amountHeader] !== "") {
    const raw = parseAmount(row[amountHeader]);
    if (!Number.isNaN(raw) && raw !== 0) {
      amount = Math.abs(raw);
      direction = raw >= 0 ? "Credit" : "Debit";
    }
  } else {
    const creditRaw = creditHeader ? parseAmount(row[creditHeader]) : NaN;
    const debitRaw = debitHeader ? parseAmount(row[debitHeader]) : NaN;
    if (!Number.isNaN(creditRaw) && creditRaw > 0) { amount = creditRaw; direction = "Credit"; }
    else if (!Number.isNaN(debitRaw) && debitRaw > 0) { amount = debitRaw; direction = "Debit"; }
  }

  if (amount === null || !direction) return null;

  const dateValue = row[dateHeader];
  const transactionDate = dateValue instanceof Date ? dateValue : new Date(dateValue);
  if (Number.isNaN(transactionDate.getTime())) return null;

  return {
    externalTransactionId: externalIdHeader ? (row[externalIdHeader] || null) : null,
    transactionDate,
    valueDate: null,
    direction,
    amount,
    reference: referenceHeader ? (row[referenceHeader] ?? null) : null,
    rawLine: JSON.stringify(row)
  };
};
