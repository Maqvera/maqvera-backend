// EXT-030 §17/§8 "Supported Knowledge Types" / "Document Chunking". Real
// text extraction (pdf-parse, mammoth, html-to-text — no hand-rolled
// binary parsing) and a real, deterministic chunking algorithm (markdown
// section-aware, configurable size/overlap) — never an LLM-based chunker,
// which would be nondeterministic and needlessly expensive for what is
// fundamentally a structural text-splitting problem.
//
// pdf-parse's package root (`pdf-parse`) has a well-known quirk: its
// index.js runs a debug/self-test code path at module-load time whenever
// `module.parent` is falsy, which ESM's CJS-interop wrapper triggers,
// causing a spurious ENOENT for a bundled sample PDF the very first time
// it's imported. Importing the inner lib file directly bypasses that
// debug wrapper entirely.
import pdfParse from "pdf-parse/lib/pdf-parse.js";
import mammoth from "mammoth";
import { convert as convertHtmlToText } from "html-to-text";
import { getAIKnowledgeConfig } from "../../utils/aiKnowledgeConfig.js";

const MIME_TO_SOURCE_TYPE = {
  "application/pdf": "pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "text/html": "html",
  "text/plain": "text",
  "text/markdown": "text",
  "application/json": "json"
};

const flattenJsonToText = (value, prefix = "") => {
  if (value == null) return "";
  if (typeof value !== "object") return `${prefix}${value}`;
  if (Array.isArray(value)) return value.map((v, i) => flattenJsonToText(v, `${prefix}[${i}] `)).filter(Boolean).join("\n");
  return Object.entries(value).map(([k, v]) => flattenJsonToText(v, `${prefix}${k}: `)).filter(Boolean).join("\n");
};

class AIKnowledgeExtractionService {
  static sourceTypeForMime(mimeType) {
    return MIME_TO_SOURCE_TYPE[mimeType] || null;
  }

  /** Real extraction per real MIME type; throws honestly for anything not in the supported list rather than guessing at binary content as plain text. */
  static async extractText(buffer, mimeType) {
    switch (mimeType) {
      case "application/pdf": {
        const result = await pdfParse(buffer);
        return result.text;
      }
      case "application/vnd.openxmlformats-officedocument.wordprocessingml.document": {
        const result = await mammoth.extractRawText({ buffer });
        return result.value;
      }
      case "text/html":
        return convertHtmlToText(buffer.toString("utf-8"), { wordwrap: false });
      case "application/json": {
        const parsed = JSON.parse(buffer.toString("utf-8"));
        return flattenJsonToText(parsed);
      }
      case "text/plain":
      case "text/markdown":
        return buffer.toString("utf-8");
      default:
        throw new Error(`Unsupported knowledge document type: ${mimeType}`);
    }
  }

  /**
   * EXT-030 §8 "Documents are divided into Sections -> Paragraphs ->
   * Chunks -> Embeddings." Splits on markdown headers first (so a chunk's
   * `sectionTitle` is real, not guessed), then paragraphs, greedily
   * packing paragraphs into chunks up to `chunkSize` with `chunkOverlap`
   * characters carried from the tail of one chunk into the start of the
   * next. A single paragraph longer than `chunkSize` is hard-split with
   * the same overlap rather than left oversized.
   */
  static chunkText(rawText, overrides = {}) {
    const { chunkSizeChars, chunkOverlapChars } = getAIKnowledgeConfig();
    const chunkSize = overrides.chunkSize || chunkSizeChars;
    const chunkOverlap = Math.min(overrides.chunkOverlap ?? chunkOverlapChars, Math.max(chunkSize - 1, 0));

    const normalized = (rawText || "").replace(/\r\n/g, "\n").trim();
    if (!normalized) return [];

    const headerRegex = /^(#{1,6}\s+.+)$/gm;
    const headerMatches = [...normalized.matchAll(headerRegex)];
    const sections = [];
    if (headerMatches.length === 0) {
      sections.push({ title: null, content: normalized });
    } else {
      if (headerMatches[0].index > 0) {
        const pre = normalized.slice(0, headerMatches[0].index).trim();
        if (pre) sections.push({ title: null, content: pre });
      }
      for (let i = 0; i < headerMatches.length; i += 1) {
        const start = headerMatches[i].index;
        const end = i + 1 < headerMatches.length ? headerMatches[i + 1].index : normalized.length;
        const title = headerMatches[i][1].replace(/^#+\s*/, "").trim();
        sections.push({ title, content: normalized.slice(start, end).trim() });
      }
    }

    const pushChunk = (chunks, sectionTitle, content) => {
      const trimmed = content.trim();
      if (trimmed) chunks.push({ sectionTitle, content: trimmed });
    };

    const chunks = [];
    for (const section of sections) {
      const paragraphs = section.content.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
      let current = "";

      for (const paragraph of paragraphs) {
        // A single paragraph longer than chunkSize can't ever fit whole —
        // flush whatever's pending, then hard-split the paragraph itself
        // into overlapping fixed-size pieces.
        if (paragraph.length > chunkSize) {
          pushChunk(chunks, section.title, current);
          current = "";
          let position = 0;
          let lastPiece = "";
          while (position < paragraph.length) {
            lastPiece = paragraph.slice(position, position + chunkSize);
            pushChunk(chunks, section.title, lastPiece);
            position += chunkSize - chunkOverlap;
          }
          // Seed the next paragraph's chunk with this piece's overlap tail
          // instead of starting it cold.
          current = lastPiece.slice(Math.max(0, lastPiece.length - chunkOverlap));
          continue;
        }

        const candidate = current ? `${current}\n\n${paragraph}` : paragraph;
        if (candidate.length <= chunkSize) {
          current = candidate;
        } else {
          pushChunk(chunks, section.title, current);
          const overlapTail = current.slice(Math.max(0, current.length - chunkOverlap));
          current = overlapTail ? `${overlapTail}\n\n${paragraph}` : paragraph;
        }
      }
      pushChunk(chunks, section.title, current);
    }

    return chunks.map((chunk, index) => ({ ...chunk, chunkIndex: index }));
  }
}

export default AIKnowledgeExtractionService;
