import { extractAmountFromText, extractDateFromText, extractVendorFromText, extractReceiptNumberFromText } from "../ExpenseOcrService.js";

// Document Intelligence Platform Phase 2 — "prefer regex/structured parsing
// over free-form LLM extraction where the field format is well-defined"
// (same non-LLM-chunker stance AIKnowledgeExtractionService already takes).
// Every extractor here is a real, deterministic template per document type,
// not a formal grammar (OCR text layout varies too widely to parse
// exhaustively) — same honest discipline ExpenseOcrService's own extractors
// already established. invoice/receipt reuse those EXACT existing helpers
// rather than re-implementing amount/date/vendor/number parsing a second
// time — an invoice and a receipt are, from an OCR-text-extraction
// standpoint, the same real problem.

const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };

/** ISO, slash, or "DD Mon YYYY" — the three real date shapes OCR'd official documents actually use. */
const parseDateToken = (token) => {
  if (!token) return null;
  const iso = token.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (iso) {
    const d = new Date(Date.UTC(+iso[1], +iso[2] - 1, +iso[3]));
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const slash = token.match(/(\d{1,2})[/.](\d{1,2})[/.](\d{4})/);
  if (slash) {
    const d = new Date(Date.UTC(+slash[3], +slash[1] - 1, +slash[2]));
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const textual = token.match(/(\d{1,2})\s+([A-Za-z]{3})[A-Za-z]*\s+(\d{4})/);
  if (textual && MONTHS[textual[2].toLowerCase()] !== undefined) {
    const d = new Date(Date.UTC(+textual[3], MONTHS[textual[2].toLowerCase()], +textual[1]));
    return Number.isNaN(d.getTime()) ? null : d;
  }
  return null;
};

const DATE_TOKEN_REGEX = /\d{4}-\d{2}-\d{2}|\d{1,2}[/.]\d{1,2}[/.]\d{4}|\d{1,2}\s+[A-Za-z]{3,9}\s+\d{4}/;

/** Finds `label`, then parses the first recognizable date within the next 40 characters after it — handles "Date of Birth: 15 MAY 1990" and "Expiry Date 2030-05-14" alike. */
const extractLabeledDate = (text, labelRegex) => {
  const match = labelRegex.exec(text);
  if (!match) return null;
  const window = text.slice(match.index + match[0].length, match.index + match[0].length + 40);
  const tokenMatch = window.match(DATE_TOKEN_REGEX);
  return tokenMatch ? parseDateToken(tokenMatch[0]) : null;
};

// Stops a captured value at whichever comes first: a newline, a
// double-space, or the start of one of this file's own OTHER known field
// labels (a closed, explicit list — not a generic "any capitalized word"
// guess, since every extractor below only ever borders labels this file
// itself defines). Not a formal grammar — OCR text has no reliable
// structural markers, same heuristic-only discipline as every other
// extractor in this file/ExpenseOcrService.
const KNOWN_LABELS = [
  "nationality", "given names?", "date of birth", "place of birth", "date of issue", "date of expiry",
  "passport (?:no\\.?|number)", "signature", "governing law", "opening balance", "closing balance",
  "statement period", "account (?:no\\.?|number)", "iban", "due date", "bill to", "invoice (?:no\\.?|number|date)", "amount due"
];
const NEXT_LABEL_LOOKAHEAD = new RegExp(`(?:${KNOWN_LABELS.join("|")})\\s*:`, "i");

/** Finds `label`, then returns the value immediately following it, stopped at the next label/newline/double-space within `maxLen` characters. */
const extractLabeledValue = (text, labelRegex, maxLen = 40) => {
  const match = labelRegex.exec(text);
  if (!match) return null;
  const window = text.slice(match.index + match[0].length, match.index + match[0].length + maxLen).replace(/^[:\s]+/, "");
  const nextLabelAt = window.search(NEXT_LABEL_LOOKAHEAD);
  const stopAt = window.search(/\r?\n|\s{2,}/);
  const candidates = [nextLabelAt, stopAt].filter((i) => i >= 0);
  const cut = candidates.length > 0 ? Math.min(...candidates) : window.length;
  const value = window.slice(0, cut).trim();
  return value || null;
};

// ---------------------------------------------------------------------------
// Passport — matches models/EnterpriseVerificationModel.js's own
// ocrResult.extractedFields shape exactly, so extraction output can be
// written straight into that already-existing field.
// ---------------------------------------------------------------------------
export const extractPassportFields = (text) => {
  if (!text) return {};
  const mrzMatch = text.match(/P<[A-Z0-9<]{40,50}/);
  return {
    passportNumber: extractLabeledValue(text, /passport\s*(?:no\.?|number)\s*[:\s]/i, 40) || (mrzMatch ? mrzMatch[0].slice(-9).replace(/</g, "") : null),
    holderName: extractLabeledValue(text, /given\s*names?\s*[:\s]/i, 60),
    nationality: extractLabeledValue(text, /nationality\s*[:\s]/i, 30),
    dateOfBirth: extractLabeledDate(text, /date\s*of\s*birth\s*[:\s]/i),
    gender: /\bsex\s*[:\s]*m\b|\bmale\b/i.test(text) ? "Male" : /\bsex\s*[:\s]*f\b|\bfemale\b/i.test(text) ? "Female" : null,
    issueDate: extractLabeledDate(text, /date\s*of\s*issue\s*[:\s]/i),
    expiryDate: extractLabeledDate(text, /date\s*of\s*expiry\s*[:\s]/i) || extractLabeledDate(text, /\bexpiry\s*(?:date)?\s*[:\s]/i),
    mrz: mrzMatch ? mrzMatch[0] : null,
    documentNumber: extractLabeledValue(text, /passport\s*(?:no\.?|number)\s*[:\s]/i, 40)
  };
};

// ---------------------------------------------------------------------------
// Invoice / Receipt — reuses ExpenseOcrService's own extractors directly.
// ---------------------------------------------------------------------------
export const extractInvoiceFields = (text) => ({
  invoiceNumber: extractReceiptNumberFromText(text),
  vendor: extractVendorFromText(text),
  amount: extractAmountFromText(text),
  invoiceDate: extractDateFromText(text),
  dueDate: extractLabeledDate(text, /due\s*date\s*[:\s]/i)
});

export const extractReceiptFields = (text) => ({
  receiptNumber: extractReceiptNumberFromText(text),
  vendor: extractVendorFromText(text),
  amount: extractAmountFromText(text),
  date: extractDateFromText(text)
});

// ---------------------------------------------------------------------------
// Bank statement
// ---------------------------------------------------------------------------
const BALANCE_REGEX = (label) => new RegExp(`${label}\\s*balance\\s*[:\\s]*[$₨€£]?\\s*([\\d,]+\\.\\d{2})`, "i");

export const extractBankStatementFields = (text) => {
  if (!text) return {};
  const opening = text.match(BALANCE_REGEX("opening"));
  const closing = text.match(BALANCE_REGEX("closing"));
  return {
    accountNumber: extractLabeledValue(text, /account\s*(?:no\.?|number)\s*[:\s]/i, 40),
    iban: extractLabeledValue(text, /\biban\s*[:\s]/i, 40),
    statementPeriod: extractLabeledValue(text, /statement\s*period\s*[:\s]/i, 60),
    openingBalance: opening ? parseFloat(opening[1].replace(/,/g, "")) : null,
    closingBalance: closing ? parseFloat(closing[1].replace(/,/g, "")) : null
  };
};

// ---------------------------------------------------------------------------
// Contract — free-text by nature; minimal, honest structured extraction
// only (parties/effective date), no fabricated summary of terms.
// ---------------------------------------------------------------------------
export const extractContractFields = (text) => ({
  effectiveDate: extractLabeledDate(text, /effective\s*date\s*[:\s]/i),
  governingLaw: extractLabeledValue(text, /governing\s*law\s*[:\s]/i, 60)
});

const EXTRACTORS = {
  passport: extractPassportFields,
  invoice: extractInvoiceFields,
  receipt: extractReceiptFields,
  bank_statement: extractBankStatementFields,
  contract: extractContractFields
};

class AIDocumentExtractionService {
  /** Dispatches to the real template extractor for `documentType`; "unknown" (or any type with no template) returns {} honestly rather than guessing a shape. */
  static extractFields(documentType, text) {
    const extractor = EXTRACTORS[documentType];
    return extractor ? extractor(text || "") : {};
  }
}

export default AIDocumentExtractionService;
