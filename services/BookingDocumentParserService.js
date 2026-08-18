import { createWorker } from "tesseract.js";
// Same ESM/CJS interop workaround as services/ExpenseOcrService.js's own
// doc comment explains — pdf-parse's root index.js runs a debug self-test
// at module-load time that ESM's CJS interop triggers, causing a spurious
// ENOENT. Import the inner lib file directly instead.
import pdfParse from "pdf-parse/lib/pdf-parse.js";
import AIModelRouterService from "./ai/AIModelRouterService.js";

const IMAGE_MIME_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/bmp", "image/tiff"]);

// PRD A7 — the actual field extraction is an LLM tool-use call routed
// through AIModelRouterService (the real "AI Gateway -> Model Router ->
// Provider Adapter -> LLM Provider" pipeline this codebase already built
// for EXT-034, same entry point AIAssistantService/AIOrchestrationService
// use), constrained to this exact schema so the model can only return these
// nine fields — never free text, never an invented field. `category:
// "reasoning"` (accurate structured extraction from unstructured text) also
// satisfies AIModelRouterService's `requiresToolCalling` gate. The pure
// regex extractors below this remain as tested, standalone building blocks
// (label-pattern documentation + a unit-testable oracle for the field set)
// but are no longer what parseHotelDocument itself calls.
const HOTEL_EXTRACTION_TOOL = {
  name: "extract_hotel_booking_fields",
  description: "Extract structured hotel booking fields from the text of a supplier/hotel confirmation document. Use null for any field genuinely not present in the text — never invent or guess a value that isn't there.",
  parameters: {
    type: "object",
    properties: {
      guestName: { type: ["string", "null"], description: "Primary guest's full name." },
      hotelName: { type: ["string", "null"], description: "Name of the hotel." },
      roomType: { type: ["string", "null"], description: "Room type/category (e.g. Deluxe Twin, Standard Double)." },
      checkIn: { type: ["string", "null"], description: "Check-in date in ISO 8601 (YYYY-MM-DD)." },
      checkOut: { type: ["string", "null"], description: "Check-out date in ISO 8601 (YYYY-MM-DD)." },
      pax: { type: ["number", "null"], description: "Number of guests/occupants." },
      ratePerNight: { type: ["number", "null"], description: "Rate per night as a plain number, no currency symbol." },
      total: { type: ["number", "null"], description: "Total/grand total amount as a plain number, no currency symbol." },
      hotelConfirmationNumber: { type: ["string", "null"], description: "Hotel confirmation number / CNF (distinct from any airline/agency booking reference)." }
    },
    required: ["guestName", "hotelName", "roomType", "checkIn", "checkOut", "pax", "ratePerNight", "total", "hotelConfirmationNumber"]
  }
};

const HOTEL_EXTRACTION_SYSTEM_PROMPT = "You extract structured fields from hotel supplier confirmation documents for a travel agency's booking system. Call extract_hotel_booking_fields exactly once with your best-effort reading of the document text. Never fabricate a value for a field that isn't genuinely present — use null instead.";

/** Parses an ISO/near-ISO date string into a Date, or null if not parseable — the AI is asked for YYYY-MM-DD but this tolerates minor drift rather than throwing. */
const parseAIDate = (value) => {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
};

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

  /** Real LLM tool-use call — throws on a genuine AI failure (no configured/reachable provider), caught by parseHotelDocument's own try/catch, same honest-failure discipline as the rest of this codebase's AI call sites. */
  static async _extractFieldsWithAI(text, tenantId) {
    const { toolCalls } = await AIModelRouterService.route({
      tenantId,
      category: "reasoning",
      messages: [{ role: "user", content: `Extract the hotel booking fields from this document text:\n\n${text.slice(0, 12000)}` }],
      tools: [HOTEL_EXTRACTION_TOOL],
      systemPrompt: HOTEL_EXTRACTION_SYSTEM_PROMPT
    });

    const call = (toolCalls || []).find((c) => c.name === "extract_hotel_booking_fields");
    if (!call) throw new Error("AI provider did not return the expected extract_hotel_booking_fields tool call.");

    const raw = call.arguments || {};
    return {
      guestName: raw.guestName || null,
      hotelName: raw.hotelName || null,
      roomType: raw.roomType || null,
      checkIn: parseAIDate(raw.checkIn),
      checkOut: parseAIDate(raw.checkOut),
      pax: typeof raw.pax === "number" ? raw.pax : null,
      ratePerNight: typeof raw.ratePerNight === "number" ? raw.ratePerNight : null,
      total: typeof raw.total === "number" ? raw.total : null,
      hotelConfirmationNumber: raw.hotelConfirmationNumber || null
    };
  }

  /**
   * Parses a supplier hotel-booking document. Never throws: a genuine
   * OCR/parsing or AI-extraction failure (including no AI provider
   * configured/reachable) is `status: "Failed"`, an unsupported file type is
   * `status: "Skipped"` — same contract as ExpenseOcrService.processAttachment.
   */
  static async parseHotelDocument(buffer, mimeType, tenantId) {
    try {
      const extraction = await BookingDocumentParserService._extractText(buffer, mimeType);
      if (!extraction) {
        return { status: "Skipped", extractedText: null, fields: null, warnings: [], confidence: null, processedAt: new Date() };
      }
      const { text, confidence } = extraction;
      const fields = await BookingDocumentParserService._extractFieldsWithAI(text, tenantId);
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
