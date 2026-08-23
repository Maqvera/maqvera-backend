import { createWorker } from "tesseract.js";
// See AIKnowledgeExtractionService.js's own doc comment for why the inner
// lib file is imported directly rather than the package root — pdf-parse's
// root index.js runs a debug self-test at module-load time that ESM's CJS
// interop triggers, causing a spurious ENOENT.
import pdfParse from "pdf-parse/lib/pdf-parse.js";

export const OCR_SUPPORTED_IMAGE_MIME_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/bmp", "image/tiff"]);

/**
 * Document Intelligence Platform Phase 1 — generalizes the real
 * tesseract.js + pdf-parse OCR primitive services/ExpenseOcrService.js
 * already had (for expense receipts only) into a reusable service any
 * document pipeline can call: passports, invoices, contracts, bank
 * statements. ExpenseOcrService now delegates to this exact implementation
 * rather than keeping its own copy — one real OCR primitive, not two.
 *
 * No external OCR API key, no fabricated result — an unsupported file type
 * returns `null` (never a made-up value), a genuine OCR/parsing failure is
 * the caller's to catch, matching this codebase's own ExpenseOcrService
 * precedent of never throwing a fabricated success.
 */
class AIDocumentOcrService {
  /** @returns {Promise<{text: string, confidence: number|null}|null>} null when mimeType isn't a supported PDF/image type. confidence is null for PDFs (pdf-parse has no OCR-confidence concept — it's real extracted text, not recognized text). */
  static async extractRawText(buffer, mimeType) {
    if (mimeType === "application/pdf") {
      const result = await pdfParse(buffer);
      return { text: result.text || "", confidence: null };
    }
    if (OCR_SUPPORTED_IMAGE_MIME_TYPES.has(mimeType)) {
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
}

export default AIDocumentOcrService;
