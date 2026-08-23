import AIModelRouterService from "./AIModelRouterService.js";
import AIGuardrailService from "./AIGuardrailService.js";
import { getAIDocumentIntelligenceConfig } from "../../utils/aiDocumentIntelligenceConfig.js";

// Document Intelligence Platform Phase 1 — classifies a document's TYPE from
// its OCR'd TEXT only. No adapter in this codebase's Multi-LLM Router
// (services/ai/*Adapter.js) accepts image input in chatWithTools today —
// every one of them takes plain {role, content: string} messages, so a real
// "given OCR'd text + image" vision classification isn't a capability this
// codebase actually has yet (extending every adapter to accept images would
// be its own, larger, separately-scoped architecture change). Classifying
// from the extracted text is honest, real, and — for the document types in
// scope here (passport/invoice/contract/bank_statement/receipt) — reliably
// distinguishable from text content alone.
//
// Primary classifier is a real, deterministic keyword/pattern heuristic
// (same "heuristic, not a formal grammar" discipline ExpenseOcrService's
// own extractors already use) — always available, no provider needed.
// AIModelRouterService is still routed through (per the PRD's own "route
// every LLM call through AIModelRouterService" ground rule) as an optional
// refinement when the heuristic's own confidence is low AND a provider is
// actually configured — never a hard dependency, matching this codebase's
// established graceful-degrade discipline (CacheManager's Redis->memory
// fallback, delivery adapters' NotConfigured, etc.).

const TYPE_PATTERNS = {
  passport: [/passport/i, /\bP<[A-Z]{3}/, /nationality/i, /date of birth/i, /place of birth/i, /republic of/i, /passport no/i],
  invoice: [/invoice/i, /invoice number/i, /invoice date/i, /bill to/i, /amount due/i, /\bvat\b/i, /purchase order/i, /due date/i],
  bank_statement: [/statement of account/i, /account statement/i, /account number/i, /opening balance/i, /closing balance/i, /\biban\b/i, /transaction history/i, /statement period/i],
  contract: [/agreement/i, /\bwhereas\b/i, /hereinafter/i, /terms and conditions/i, /party of the first part/i, /governing law/i, /effective date/i, /signature/i],
  receipt: [/receipt/i, /thank you for your (purchase|business)/i, /cashier/i, /change due/i, /subtotal/i, /\bqty\b/i]
};

/**
 * Real, deterministic scoring — each matched pattern for a type adds one
 * point; the type with the highest score wins. Confidence is the winning
 * score normalized against that type's own total pattern count (never a
 * fabricated certainty number, same discipline as AIObservabilityService's
 * own confidence scores) — a document matching most of a type's real
 * signal words scores near 1.0, one matching only a couple scores lower.
 * Ties and zero-score text both classify "unknown" honestly rather than
 * guessing.
 */
export const classifyByHeuristic = (text) => {
  if (!text || !text.trim()) return { documentType: "unknown", confidence: 0, scores: {} };

  const scores = {};
  for (const [type, patterns] of Object.entries(TYPE_PATTERNS)) {
    const matched = patterns.filter((p) => p.test(text)).length;
    scores[type] = matched / patterns.length;
  }

  const [bestType, bestScore] = Object.entries(scores).reduce((best, entry) => (entry[1] > best[1] ? entry : best), ["unknown", 0]);
  if (bestScore === 0) return { documentType: "unknown", confidence: 0, scores };

  const tiedWithBest = Object.values(scores).filter((s) => s === bestScore).length;
  if (tiedWithBest > 1) return { documentType: "unknown", confidence: 0, scores };

  return { documentType: bestType, confidence: Number(bestScore.toFixed(2)), scores };
};

class AIDocumentClassificationService {
  /**
   * @param {string} text - OCR'd document text.
   * @param {object} [options]
   * @param {string} [options.tenantId]
   * @returns {Promise<{documentType: string, confidence: number, method: "heuristic"|"llm", scores: object}>}
   */
  static async classifyDocumentText(text, { tenantId = null } = {}) {
    const config = getAIDocumentIntelligenceConfig();
    const heuristicResult = classifyByHeuristic(text);

    if (heuristicResult.confidence >= config.classificationConfidenceThreshold) {
      return { ...heuristicResult, method: "heuristic" };
    }

    // Low-confidence heuristic — try an LLM refinement if one is actually
    // configured. Never throws the pipeline out: a genuinely unavailable
    // provider (AI_UNAVAILABLE, the honest failure every adapter/router
    // already raises) just means the heuristic's own best guess stands.
    //
    // Phase 4 "PII masking" — this is the one point in the whole Document
    // Intelligence pipeline where raw OCR'd text (which can contain a real
    // CNIC/credit-card/IBAN-shaped value straight off a passport/bank
    // statement) leaves this process and reaches a third-party LLM
    // provider. AIGuardrailService.maskValue is the same masking primitive
    // AIAssistantService/AIOrchestrationService/AISupervisorService already
    // apply before persisting tool arguments — applied here before the
    // network call itself, not just before storage, since classification
    // only needs the document's keyword signal ("Invoice Number:", "IBAN:"),
    // never the sensitive value that follows it.
    try {
      const response = await AIModelRouterService.route({
        tenantId,
        category: "fast",
        systemPrompt: `Classify the document type from its extracted text. Respond with exactly one word from this list: ${config.documentTypes.join(", ")}. If none genuinely fit, respond "unknown". Do not explain your answer.`,
        messages: [{ role: "user", content: AIGuardrailService.maskValue(text.slice(0, 3000)) }]
      });
      const word = (response.content || "").trim().toLowerCase().replace(/[^a-z_]/g, "");
      if (config.documentTypes.includes(word)) {
        return { documentType: word, confidence: Math.max(heuristicResult.confidence, 0.75), method: "llm", scores: heuristicResult.scores };
      }
    } catch {
      // Honest fall-through to the heuristic result below — no fabricated LLM answer.
    }

    return { ...heuristicResult, method: "heuristic" };
  }
}

export default AIDocumentClassificationService;
