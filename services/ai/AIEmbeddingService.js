import OpenAI from "openai";
import { getAIConfig } from "../../utils/aiConfig.js";
import { getAIKnowledgeConfig } from "../../utils/aiKnowledgeConfig.js";

/**
 * EXT-030 §21 "Future Ready — OpenAI Embeddings, Azure OpenAI, ..." Only
 * these two are real here, both via this codebase's already-installed
 * `openai` SDK (same package OpenAIAdapter.js/AzureOpenAIAdapter.js
 * already use for chat) — no separate embeddings-only SDK needed. Voyage
 * AI/Jina AI/Cohere/Sentence Transformers are honestly left as the doc's
 * own "(Future)"-equivalent list, not fabricated.
 */
class AIEmbeddingService {
  static _openaiClient = undefined;
  static _azureClient = undefined;

  static _getOpenAIClient() {
    if (this._openaiClient !== undefined) return this._openaiClient;
    const { openai } = getAIConfig();
    this._openaiClient = openai.apiKey ? new OpenAI({ apiKey: openai.apiKey, baseURL: openai.baseUrl }) : null;
    return this._openaiClient;
  }

  static _getAzureClient() {
    if (this._azureClient !== undefined) return this._azureClient;
    const { azureOpenAI } = getAIConfig();
    const { azureEmbeddingDeployment } = getAIKnowledgeConfig();
    this._azureClient = (azureOpenAI.apiKey && azureOpenAI.endpoint && azureEmbeddingDeployment)
      ? new OpenAI({
          apiKey: azureOpenAI.apiKey,
          baseURL: `${azureOpenAI.endpoint.replace(/\/$/, "")}/openai/deployments/${azureEmbeddingDeployment}`,
          defaultQuery: { "api-version": azureOpenAI.apiVersion },
          defaultHeaders: { "api-key": azureOpenAI.apiKey }
        })
      : null;
    return this._azureClient;
  }

  static isConfigured() {
    return Boolean(this._getOpenAIClient() || this._getAzureClient());
  }

  /**
   * Tries the configured `AI_EMBEDDING_PROVIDER` first, falls back to the
   * other real provider if available — same failover spirit as
   * AIOrchestrationService._callLLM, scaled to embeddings' simpler
   * single-call shape. Throws a clearly-labeled AI_UNAVAILABLE error when
   * neither is configured — no fabricated vector, ever.
   */
  static async generateEmbedding(text) {
    const { embeddingProvider, embeddingModel, azureEmbeddingDeployment } = getAIKnowledgeConfig();
    const attempts = embeddingProvider === "AzureOpenAI" ? ["AzureOpenAI", "OpenAI"] : ["OpenAI", "AzureOpenAI"];

    let lastError = null;
    for (const provider of attempts) {
      const client = provider === "AzureOpenAI" ? this._getAzureClient() : this._getOpenAIClient();
      if (!client) continue;
      try {
        const response = await client.embeddings.create({
          model: provider === "AzureOpenAI" ? azureEmbeddingDeployment : embeddingModel,
          input: text
        });
        const embedding = response.data?.[0]?.embedding;
        if (!Array.isArray(embedding) || embedding.length === 0) throw new Error("Embedding provider returned no vector.");
        return { embedding, model: embeddingModel, provider };
      } catch (err) {
        lastError = err;
      }
    }

    const error = new Error(`AI embedding service is not available: no configured provider (OPENAI_API_KEY / AZURE_OPENAI_*) could generate an embedding.${lastError ? ` Last error: ${lastError.message}` : ""}`);
    error.code = "AI_UNAVAILABLE";
    throw error;
  }

  /** Real cosine similarity — the actual semantic-search ranking signal (§9 "Semantic Match"), computed in application code since no vector-index-capable database is configured (see AIKnowledgeChunkModel's docblock). */
  static cosineSimilarity(a, b) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length || a.length === 0) return 0;
    let dot = 0, normA = 0, normB = 0;
    for (let i = 0; i < a.length; i += 1) {
      dot += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }
    if (normA === 0 || normB === 0) return 0;
    return dot / (Math.sqrt(normA) * Math.sqrt(normB));
  }
}

export default AIEmbeddingService;
