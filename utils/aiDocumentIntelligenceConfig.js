import dotenv from "dotenv";
dotenv.config();

const parseNumber = (value, fallback) => {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const parseJsonArray = (value, fallback) => {
  if (!value) return fallback;
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : fallback;
  } catch {
    return fallback;
  }
};

/**
 * Enterprise Document Intelligence Platform (Gap-Fix PRD Section 2, Phase
 * 1-3) — config-driven per this codebase's own convention (CLAUDE.md
 * "Config-driven domain values"), mirrors utils/aiKnowledgeConfig.js's own
 * shape for the same domain (AI document processing).
 */
export const getAIDocumentIntelligenceConfig = () => ({
  // The closed set AIDocumentClassificationService classifies into —
  // "unknown" is always a real, honest possible outcome, never forced.
  documentTypes: parseJsonArray(process.env.AI_DOCUMENT_TYPES_JSON, [
    "passport", "invoice", "contract", "bank_statement", "receipt", "unknown"
  ]),

  // Below this, classification is not confident enough to drive extraction
  // template selection automatically — the pipeline still records its best
  // guess (never silently drops it) but flags it for human confirmation
  // rather than treating it as authoritative.
  classificationConfidenceThreshold: parseNumber(process.env.AI_DOCUMENT_CLASSIFICATION_CONFIDENCE_THRESHOLD, 0.6),

  // Phase 3 "Confidence-Based Human Review" — below this, a document is
  // flagged for priority manual review with the AI's own findings attached
  // as context (never auto-approved: this pipeline hands off to a human
  // for the actual approval decision either way, same as every other path
  // through DocumentVerificationService.submitManualReview — auto-approving
  // a legal travel/identity document without a human is a compliance risk
  // this build does not take on).
  reviewConfidenceThreshold: parseNumber(process.env.AI_DOCUMENT_REVIEW_CONFIDENCE_THRESHOLD, 0.7),

  ocrLowConfidenceThreshold: parseNumber(process.env.AI_DOCUMENT_OCR_LOW_CONFIDENCE_THRESHOLD, 60)
});

export default getAIDocumentIntelligenceConfig;
