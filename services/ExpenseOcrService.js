import { createWorker } from "tesseract.js";
// See services/ai/AIKnowledgeExtractionService.js's own doc comment for
// why the inner lib file is imported directly rather than the package
// root — pdf-parse's root index.js runs a debug self-test at module-load
// time that ESM's CJS interop triggers, causing a spurious ENOENT.
import pdfParse from "pdf-parse/lib/pdf-parse.js";

const IMAGE_MIME_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/bmp", "image/tiff"]);

// ---------------------------------------------------------------------------
// Pure text-parsing helpers — no OCR/DB access, unit-testable directly (see
// tests/expenseOcrService.test.js). Heuristic, not a formal receipt-parsing
// grammar (no two receipt layouts are alike) — same honest "handles the
// common case, real-world variance needs adjustment" stance already applied
// to the MT940 statement parser (Part 14).
// ---------------------------------------------------------------------------

// Negative lookbehind on "total" so "Subtotal: 100.00" is never mistaken
// for the real "Total: 115.00" line — a real bug caught while smoke-
// testing this exact regex against a sample receipt during development.
const AMOUNT_KEYWORD_REGEX = /(?:grand total|amount due|(?<!sub)total|amount)[:\s]*[$₨€£]?\s*([\d,]+\.\d{2})/i;
const ANY_AMOUNT_REGEX = /[$₨€£]?\s*(\d{1,3}(?:,\d{3})*\.\d{2})/g;

/** Prefers a labeled "Total"/"Amount Due" figure; falls back to the largest currency-shaped number in the text. */
export const extractAmountFromText = (text) => {
  if (!text) return null;
  const keywordMatch = text.match(AMOUNT_KEYWORD_REGEX);
  if (keywordMatch) return parseFloat(keywordMatch[1].replace(/,/g, ""));

  const allMatches = [...text.matchAll(ANY_AMOUNT_REGEX)].map((m) => parseFloat(m[1].replace(/,/g, "")));
  if (allMatches.length === 0) return null;
  return Math.max(...allMatches);
};

/** Tries ISO (YYYY-MM-DD) first, then a common slash-date format (assumes MM/DD/YYYY). */
export const extractDateFromText = (text) => {
  if (!text) return null;
  const isoMatch = text.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (isoMatch) {
    const date = new Date(Date.UTC(Number(isoMatch[1]), Number(isoMatch[2]) - 1, Number(isoMatch[3])));
    if (!Number.isNaN(date.getTime())) return date;
  }
  const slashMatch = text.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (slashMatch) {
    const date = new Date(Date.UTC(Number(slashMatch[3]), Number(slashMatch[1]) - 1, Number(slashMatch[2])));
    if (!Number.isNaN(date.getTime())) return date;
  }
  return null;
};

/** Heuristic: the merchant name is almost always the first non-empty line on a receipt. */
export const extractVendorFromText = (text) => {
  if (!text) return null;
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  return lines.length > 0 ? lines[0].slice(0, 200) : null;
};

// "OCR Information... Receipt Number" (Enterprise Expense Management
// Refactor Part 4/4). Same heuristic discipline as the other extractors
// above — a labeled "Receipt/Invoice/Order/Ref #" line, not a formal
// grammar (receipt numbering formats vary too widely to parse exhaustively).
const RECEIPT_NUMBER_REGEX = /(?:receipt|invoice|order|ref(?:erence)?)\s*(?:#|no\.?|number)?[:\s]*([A-Z0-9][A-Z0-9\-\/]{2,24})/i;

/** Prefers a labeled "Receipt #"/"Invoice No"/"Order #"/"Ref" value. */
export const extractReceiptNumberFromText = (text) => {
  if (!text) return null;
  const match = text.match(RECEIPT_NUMBER_REGEX);
  return match ? match[1].trim() : null;
};

// ---------------------------------------------------------------------------
// Service — real OCR (tesseract.js for images), real text extraction
// (pdf-parse for text-based PDFs, already installed for AI Knowledge
// document ingestion). No external API key, no fabricated result — an
// unsupported file type is honestly "Skipped", never a made-up value.
// ---------------------------------------------------------------------------

class ExpenseOcrService {
  static async _extractText(buffer, mimeType) {
    if (mimeType === "application/pdf") {
      const result = await pdfParse(buffer);
      return { text: result.text || "", confidence: null };
    }
    if (IMAGE_MIME_TYPES.has(mimeType)) {
      const worker = await createWorker("eng");
      try {
        const { data } = await worker.recognize(buffer);
        return { text: data.text || "", confidence: data.confidence ?? null };
      } finally {
        await worker.terminate();
      }
    }
    return null;
  }

  /**
   * "OCR Extraction" — real text extraction plus the pure field-parsing
   * helpers above. Never throws to the caller: a genuine OCR/parsing
   * failure is recorded as `status: "Failed"`, an unsupported file type as
   * `status: "Skipped"` — ExpenseService.uploadReceipt always succeeds at
   * attaching the file even when OCR itself can't run.
   */
  static async processAttachment(buffer, mimeType) {
    try {
      const extraction = await ExpenseOcrService._extractText(buffer, mimeType);
      if (!extraction) {
        return { status: "Skipped", extractedText: null, extractedAmount: null, extractedDate: null, extractedVendor: null, extractedReceiptNumber: null, confidence: null, processedAt: new Date() };
      }
      const { text, confidence } = extraction;
      return {
        status: "Completed",
        extractedText: text.slice(0, 5000),
        extractedAmount: extractAmountFromText(text),
        extractedDate: extractDateFromText(text),
        extractedVendor: extractVendorFromText(text),
        extractedReceiptNumber: extractReceiptNumberFromText(text),
        confidence,
        processedAt: new Date()
      };
    } catch (error) {
      return { status: "Failed", extractedText: null, extractedAmount: null, extractedDate: null, extractedVendor: null, extractedReceiptNumber: null, confidence: null, processedAt: new Date(), error: error.message };
    }
  }
}

export default ExpenseOcrService;
