import { createWorker } from "tesseract.js";
// Same ESM/CJS interop workaround as services/ExpenseOcrService.js's own
// doc comment explains — pdf-parse's root index.js runs a debug self-test
// at module-load time that ESM's CJS interop triggers, causing a spurious
// ENOENT. Import the inner lib file directly instead.
import pdfParse from "pdf-parse/lib/pdf-parse.js";

const IMAGE_MIME_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/bmp", "image/tiff"]);

// ---------------------------------------------------------------------------
// Pure text-parsing helpers — no OCR/DB access, unit-testable directly (see
// tests/bookingDocumentParserService.test.js). Direct sibling of
// services/ExpenseOcrService.js's own extractors, same heuristic discipline
// (labeled field first, honest `null` when nothing matches — never a
// fabricated value) but targeting a hotel supplier confirmation PDF's field
// set instead of a retail receipt's (booking-module PRD Part B item #8,
// HotelBookingExtractionSchema).
// ---------------------------------------------------------------------------

const DATE_WINDOW = 40;

/** Finds `labelRegex` in `text` and looks for a date within the next `DATE_WINDOW` characters — ISO first, then MM/DD/YYYY. */
const extractLabeledDate = (text, labelRegex) => {
  if (!text) return null;
  const labelMatch = text.match(labelRegex);
  if (!labelMatch) return null;
  const windowStart = labelMatch.index + labelMatch[0].length;
  const window = text.slice(windowStart, windowStart + DATE_WINDOW);

  const isoMatch = window.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (isoMatch) {
    const date = new Date(Date.UTC(Number(isoMatch[1]), Number(isoMatch[2]) - 1, Number(isoMatch[3])));
    if (!Number.isNaN(date.getTime())) return date;
  }
  const slashMatch = window.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (slashMatch) {
    const date = new Date(Date.UTC(Number(slashMatch[3]), Number(slashMatch[1]) - 1, Number(slashMatch[2])));
    if (!Number.isNaN(date.getTime())) return date;
  }
  return null;
};

// Labels are anchored to the START of a line and require an actual colon
// immediately after the label word — a bare `label[:\s]+` (no anchor, no
// required colon) is too loose: it can match the label word as a substring
// of unrelated text (caught in testing — "Grand Palace Hotel\nHotel CNF#:
// ..." matched "hotel" inside the hotel's own name, then bled into the next
// line's unrelated "CNF#" label, producing "Hotel CNF" instead of either
// real field). Requiring `^label\s*:` makes a label match only a genuine
// "Field: value" line.

/** Prefers a labeled "Guest Name"/"Guest" line. */
export const extractGuestNameFromText = (text) => {
  if (!text) return null;
  const match = text.match(/^\s*guest(?:\s*name)?\s*:\s*([^\n]{1,60})/im);
  return match ? match[1].trim() : null;
};

/** Prefers a labeled "Hotel"/"Hotel Name" line; falls back to the first non-empty line (same "first line is the header" heuristic as extractVendorFromText). */
export const extractHotelNameFromText = (text) => {
  if (!text) return null;
  const labeled = text.match(/^\s*hotel(?:\s*name)?\s*:\s*([^\n]{1,80})/im);
  if (labeled) return labeled[1].trim();
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  return lines.length > 0 ? lines[0].slice(0, 200) : null;
};

/** Prefers a labeled "Room Type"/"Room" line. */
export const extractRoomTypeFromText = (text) => {
  if (!text) return null;
  const match = text.match(/^\s*room(?:\s*type)?\s*:\s*([^\n]{1,60})/im);
  return match ? match[1].trim() : null;
};

/** Labeled "Check-in"/"Check In"/"Arrival" date. */
export const extractCheckInFromText = (text) => extractLabeledDate(text, /check[\s-]?in|arrival/i);

/** Labeled "Check-out"/"Check Out"/"Departure" date. */
export const extractCheckOutFromText = (text) => extractLabeledDate(text, /check[\s-]?out|departure/i);

/** Labeled "Pax"/"Guests"/"Occupancy" count. */
export const extractPaxFromText = (text) => {
  if (!text) return null;
  const match = text.match(/(?:pax|guests?|occupancy)[:\s]+(\d{1,2})/i);
  return match ? parseInt(match[1], 10) : null;
};

/** Labeled "Rate per Night"/"Nightly Rate"/"Rate/Night" figure. */
export const extractRatePerNightFromText = (text) => {
  if (!text) return null;
  const match = text.match(/(?:rate\s*(?:\/|per)\s*night|nightly\s*rate)[:\s]*[$₨€£]?\s*([\d,]+\.?\d{0,2})/i);
  return match ? parseFloat(match[1].replace(/,/g, "")) : null;
};

/** Prefers a labeled "Total"/"Grand Total"/"Amount Due" figure — same negative-lookbehind-on-Subtotal discipline as ExpenseOcrService's extractAmountFromText. */
export const extractTotalFromText = (text) => {
  if (!text) return null;
  const keywordMatch = text.match(/(?:grand total|amount due|(?<!sub)total)[:\s]*[$₨€£]?\s*([\d,]+\.\d{2})/i);
  if (keywordMatch) return parseFloat(keywordMatch[1].replace(/,/g, ""));
  const allMatches = [...text.matchAll(/[$₨€£]?\s*(\d{1,3}(?:,\d{3})*\.\d{2})/g)].map((m) => parseFloat(m[1].replace(/,/g, "")));
  return allMatches.length > 0 ? Math.max(...allMatches) : null;
};

// "Hotel CNF#" (Document 3 §68/91's own label mapping) — deliberately a
// distinct field/extractor from a generic "confirmation number," since the
// PRD explicitly flags BRN vs Hotel CNF as possibly different fields not to
// be merged without a business decision (booking-module PRD item #9).
export const extractHotelConfirmationNumberFromText = (text) => {
  if (!text) return null;
  const match = text.match(/(?:hotel\s*cnf#?|confirmation\s*(?:number|no\.?|#)|cnf#?)[:\s]*([A-Z0-9][A-Z0-9\-\/]{2,24})/i);
  return match ? match[1].trim() : null;
};

// ---------------------------------------------------------------------------
// Cross-field validation (Document 3 §24) — "please verify" flags, never a
// blocked submission and never a silently-overridden value.
// ---------------------------------------------------------------------------

/** Returns `needsReview` warning strings for a parsed hotel-document field set. Pure — no DB, no I/O. */
export const validateHotelExtraction = (fields) => {
  const warnings = [];
  if (fields.checkIn && fields.checkOut && fields.checkOut.getTime() <= fields.checkIn.getTime()) {
    warnings.push("checkOut is not after checkIn — please verify.");
  }
  if (fields.checkIn && fields.checkOut && fields.ratePerNight != null && fields.total != null) {
    const nights = Math.round((fields.checkOut.getTime() - fields.checkIn.getTime()) / (24 * 60 * 60 * 1000));
    const expectedTotal = nights * fields.ratePerNight;
    if (nights > 0 && Math.abs(expectedTotal - fields.total) > Math.max(1, expectedTotal * 0.05)) {
      warnings.push(`Total (${fields.total}) does not match nights (${nights}) x rate per night (${fields.ratePerNight}) — please verify.`);
    }
  }
  return warnings;
};

// ---------------------------------------------------------------------------
// Service — real OCR (tesseract.js for images), real text extraction
// (pdf-parse for text-based PDFs). No external API key, no fabricated
// result — an unsupported file type is honestly "Skipped." Extraction only
// — never saves anything, keeping "AI extracts, employee reviews" as two
// separate steps (Document 3 §21).
// ---------------------------------------------------------------------------

class BookingDocumentParserService {
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
   * Parses a supplier hotel-booking document. Never throws: a genuine
   * OCR/parsing failure is `status: "Failed"`, an unsupported file type is
   * `status: "Skipped"` — same contract as ExpenseOcrService.processAttachment.
   */
  static async parseHotelDocument(buffer, mimeType) {
    try {
      const extraction = await BookingDocumentParserService._extractText(buffer, mimeType);
      if (!extraction) {
        return { status: "Skipped", extractedText: null, fields: null, warnings: [], confidence: null, processedAt: new Date() };
      }
      const { text, confidence } = extraction;
      const fields = {
        guestName: extractGuestNameFromText(text),
        hotelName: extractHotelNameFromText(text),
        roomType: extractRoomTypeFromText(text),
        checkIn: extractCheckInFromText(text),
        checkOut: extractCheckOutFromText(text),
        pax: extractPaxFromText(text),
        ratePerNight: extractRatePerNightFromText(text),
        total: extractTotalFromText(text),
        hotelConfirmationNumber: extractHotelConfirmationNumberFromText(text)
      };
      return {
        status: "Completed",
        extractedText: text.slice(0, 5000),
        fields,
        warnings: validateHotelExtraction(fields),
        confidence,
        processedAt: new Date()
      };
    } catch (error) {
      return { status: "Failed", extractedText: null, fields: null, warnings: [], confidence: null, processedAt: new Date(), error: error.message };
    }
  }
}

export default BookingDocumentParserService;
