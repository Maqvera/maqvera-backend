import mongoose from "mongoose";
import AIKnowledgeDocumentModel from "../models/AIKnowledgeDocumentModel.js";
import AIKnowledgeChunkModel from "../models/AIKnowledgeChunkModel.js";
import AIEmbeddingService from "./ai/AIEmbeddingService.js";
import AIKnowledgeExtractionService from "./ai/AIKnowledgeExtractionService.js";
import { getAIKnowledgeConfig } from "../utils/aiKnowledgeConfig.js";
import { publishEvent } from "../utils/eventBus.js";

const STOPWORDS = new Set(["the", "a", "an", "is", "are", "was", "were", "in", "on", "of", "to", "for", "and", "or", "what", "how", "does", "do", "our", "your", "this", "that", "with", "from", "we", "us"]);

const normalizeWords = (text) => (text || "").toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter((w) => w.length > 2 && !STOPWORDS.has(w));

const overlapRatio = (querySet, words) => {
  if (querySet.size === 0) return 0;
  const wordSet = new Set(words);
  let hits = 0;
  for (const w of querySet) if (wordSet.has(w)) hits += 1;
  return hits / querySet.size;
};

/**
 * EXT-030 "AI Knowledge & Context Retrieval (RAG Layer)". Distinct from
 * models/EnterpriseDocumentModel.js's file-attachment concern (passport
 * scans etc. tied to a visa case/customer/booking) — this is organizational
 * knowledge (SOPs, policies, FAQs) the AI retrieves to ground its answers,
 * with no owning entity.
 */
class AIKnowledgeService {
  /**
   * §6 "Knowledge Levels ... AI retrieves only authorized knowledge."
   * Hierarchical: a caller authorized for a higher tier can also see every
   * tier below it. `admin`/`superadmin` (the same universal override every
   * other permission check in this AI module already grants) always passes.
   */
  static hasKnowledgeAccess(visibilityLevel, { role, permissions = [] }) {
    if (permissions.includes("admin") || permissions.includes("superadmin")) return true;
    const tiers = ["public", "internal", "operations", "management", "executive"];
    const targetIndex = tiers.indexOf(visibilityLevel);
    if (targetIndex <= 0) return true; // public

    const config = getAIKnowledgeConfig();
    const normalizedRole = (role || "").toLowerCase();
    let callerTierIndex = permissions.length > 0 ? 1 : 0; // any authenticated AI-access caller reaches "internal"
    if (config.executiveRoles.includes(normalizedRole)) callerTierIndex = 4;
    else if (config.managementRoles.includes(normalizedRole)) callerTierIndex = 3;
    else if (config.operationsRoles.includes(normalizedRole)) callerTierIndex = Math.max(callerTierIndex, 2);

    return targetIndex <= callerTierIndex;
  }

  static async _validateCategory(category) {
    const { categories } = getAIKnowledgeConfig();
    if (!categories.includes(category)) throw new Error(`Invalid knowledge category '${category}'. Must be one of: ${categories.join(", ")}.`);
  }

  /** §18 "Knowledge Updates — New Document -> Validation -> Chunking -> Embedding -> Vector Index -> Available to AI. No model retraining required." */
  static async _chunkAndEmbedDocument(doc) {
    const chunks = AIKnowledgeExtractionService.chunkText(doc.content);
    const created = [];
    for (const chunk of chunks) {
      const { embedding, model, provider } = await AIEmbeddingService.generateEmbedding(chunk.content);
      created.push(await AIKnowledgeChunkModel.create({
        documentId: doc._id, tenantId: doc.tenantId, branchId: doc.branchId,
        chunkIndex: chunk.chunkIndex, sectionTitle: chunk.sectionTitle, content: chunk.content,
        embedding, embeddingModel: model, embeddingProvider: provider,
        documentTitle: doc.title, documentCategory: doc.category, documentVersion: doc.version,
        visibilityLevel: doc.visibilityLevel, tags: doc.tags, language: doc.language, author: doc.author,
        isActive: true
      }));
    }
    return created;
  }

  static async createDocument({ tenantId, branchId, userId, title, category, visibilityLevel, content, tags, language, author, sourceType, sourceFileName }) {
    if (!title || !title.trim()) throw new Error("title is required.");
    if (!content || !content.trim()) throw new Error("content is required.");
    await this._validateCategory(category);

    const doc = await AIKnowledgeDocumentModel.create({
      tenantId, branchId: branchId || "main", title: title.trim(), category,
      visibilityLevel: visibilityLevel || "internal", content: content.trim(),
      tags: Array.isArray(tags) ? tags : [], language: language || "en", author: author || null,
      sourceType: sourceType || "text", sourceFileName: sourceFileName || null,
      createdBy: userId, version: 1, status: "active"
    });

    const chunks = await this._chunkAndEmbedDocument(doc);
    publishEvent("AIKnowledgeDocumentCreated", { documentId: doc._id, tenantId, category, visibilityLevel: doc.visibilityLevel, chunkCount: chunks.length });
    return { document: doc, chunkCount: chunks.length };
  }

  /**
   * §14 "Version Control — Only active document versions retrieved."
   * Content change -> archive the old version's chunks (kept, not
   * deleted, for "Historical lookup ... if requested") and generate a
   * fresh set at the bumped version. A metadata-only change (title/
   * category/visibility/tags) re-syncs the same denormalized fields onto
   * the still-current chunks without a wasteful re-embed.
   */
  static async updateDocument({ tenantId, userId, documentId, title, category, visibilityLevel, content, tags, language, author }) {
    const doc = await AIKnowledgeDocumentModel.findOne({ _id: documentId, tenantId });
    if (!doc) throw new Error("Knowledge document not found.");
    if (doc.status !== "active") throw new Error(`Knowledge document is '${doc.status}' and cannot be updated.`);
    if (category != null) await this._validateCategory(category);

    const contentChanged = content != null && content.trim() !== doc.content;
    if (title != null) doc.title = title.trim();
    if (category != null) doc.category = category;
    if (visibilityLevel != null) doc.visibilityLevel = visibilityLevel;
    if (tags != null) doc.tags = Array.isArray(tags) ? tags : [];
    if (language != null) doc.language = language;
    if (author != null) doc.author = author;
    if (content != null) doc.content = content.trim();
    doc.updatedBy = userId;
    if (contentChanged) doc.version += 1;
    await doc.save();

    let chunkCount;
    if (contentChanged) {
      await AIKnowledgeChunkModel.updateMany({ documentId: doc._id, isActive: true }, { $set: { isActive: false } });
      const chunks = await this._chunkAndEmbedDocument(doc);
      chunkCount = chunks.length;
    } else {
      await AIKnowledgeChunkModel.updateMany(
        { documentId: doc._id, isActive: true },
        { $set: { documentTitle: doc.title, documentCategory: doc.category, documentVersion: doc.version, visibilityLevel: doc.visibilityLevel, tags: doc.tags, language: doc.language, author: doc.author } }
      );
      chunkCount = await AIKnowledgeChunkModel.countDocuments({ documentId: doc._id, isActive: true });
    }

    publishEvent("AIKnowledgeDocumentUpdated", { documentId: doc._id, tenantId, version: doc.version, reEmbedded: contentChanged });
    return { document: doc, chunkCount };
  }

  static async archiveDocument({ tenantId, userId, documentId }) {
    const doc = await AIKnowledgeDocumentModel.findOne({ _id: documentId, tenantId });
    if (!doc) throw new Error("Knowledge document not found.");
    if (doc.status === "archived") throw new Error("Knowledge document is already archived.");
    doc.status = "archived";
    doc.archivedAt = new Date();
    doc.updatedBy = userId;
    await doc.save();
    await AIKnowledgeChunkModel.updateMany({ documentId: doc._id }, { $set: { isActive: false } });
    publishEvent("AIKnowledgeDocumentArchived", { documentId: doc._id, tenantId });
    return doc;
  }

  static async listDocuments({ tenantId, branchId, category, status = "active", page = 1, pageSize = 20 }) {
    const safePage = Math.max(parseInt(page, 10) || 1, 1);
    const safePageSize = Math.min(Math.max(parseInt(pageSize, 10) || 20, 1), 100);
    const filter = { tenantId };
    if (branchId) filter.branchId = { $in: [branchId, "main"] };
    if (category) filter.category = category;
    if (status) filter.status = status;

    const [items, totalItems] = await Promise.all([
      AIKnowledgeDocumentModel.find(filter).sort({ updatedAt: -1 }).skip((safePage - 1) * safePageSize).limit(safePageSize)
        .select("title category visibilityLevel version status tags language sourceType createdAt updatedAt").lean(),
      AIKnowledgeDocumentModel.countDocuments(filter)
    ]);
    return { items, pagination: { page: safePage, pageSize: safePageSize, totalItems, totalPages: Math.ceil(totalItems / safePageSize) || 1 } };
  }

  static async getDocumentById({ tenantId, documentId }) {
    const doc = await AIKnowledgeDocumentModel.findOne({ _id: documentId, tenantId }).lean();
    if (!doc) throw new Error("Knowledge document not found.");
    return doc;
  }

  /**
   * §9 "Ranking Strategy — Semantic Match -> Keyword Match -> Title Match
   * -> Tag Match -> Freshness -> Popularity -> AI Confidence." A real
   * weighted composite (mirrors services/ai/AIRankingService.js's existing
   * pattern for flight/hotel offers) — "AI Confidence" isn't a separate
   * seventh input (nothing in this codebase produces one independently of
   * the retrieval itself), it's this composite score surfaced back as the
   * citation's `confidence` value.
   */
  static rankChunks(chunks, queryEmbedding, queryText) {
    const { rankingWeights } = getAIKnowledgeConfig();
    const queryWords = new Set(normalizeWords(queryText));
    const maxRetrievalCount = Math.max(1, ...chunks.map((c) => c.retrievalCount || 0));
    const now = Date.now();

    return chunks
      .map((chunk) => {
        const semantic = Math.max(0, AIEmbeddingService.cosineSimilarity(queryEmbedding, chunk.embedding));
        const keyword = overlapRatio(queryWords, normalizeWords(chunk.content));
        const title = overlapRatio(queryWords, normalizeWords(chunk.documentTitle));
        const tag = (chunk.tags || []).some((t) => queryWords.has(String(t).toLowerCase())) ? 1 : 0;
        const daysSinceUpdate = (now - new Date(chunk.updatedAt).getTime()) / 86400000;
        const freshness = Math.max(0, 1 - daysSinceUpdate / 365);
        const popularity = (chunk.retrievalCount || 0) / maxRetrievalCount;

        const score = (rankingWeights.semantic * semantic) + (rankingWeights.keyword * keyword) + (rankingWeights.title * title)
          + (rankingWeights.tag * tag) + (rankingWeights.freshness * freshness) + (rankingWeights.popularity * popularity);

        return { ...chunk, score, scoreBreakdown: { semantic, keyword, title, tag, freshness, popularity } };
      })
      .sort((a, b) => b.score - a.score);
  }

  /** §10 "Context Builder ... Only relevant context included." / §13 "Context Window ... Older chunks removed first, higher ranked retained." `chunks` must already be rank-sorted descending. */
  static buildContextBlock(rankedChunks, maxContextChars) {
    let used = 0;
    const included = [];
    for (const chunk of rankedChunks) {
      const rendered = `[${chunk.documentTitle}${chunk.sectionTitle ? ` — ${chunk.sectionTitle}` : ""}]\n${chunk.content}`;
      if (used + rendered.length > maxContextChars && included.length > 0) break;
      included.push({ chunk, rendered });
      used += rendered.length;
    }
    const contextText = included.length > 0 ? included.map((i) => i.rendered).join("\n\n---\n\n") : null;
    // §15 "AI Citations — Document Name, Section, Version, Timestamp, Confidence."
    const citations = included.map(({ chunk }) => ({
      documentId: chunk.documentId, title: chunk.documentTitle, section: chunk.sectionTitle || null,
      version: chunk.documentVersion, category: chunk.documentCategory, updatedAt: chunk.updatedAt,
      confidence: Number(chunk.score.toFixed(3))
    }));
    return { contextText, citations };
  }

  /**
   * The end-to-end retrieval flow (§7): normalize -> embed -> candidate
   * fetch (tenant + branch, "main" as this codebase's existing
   * branch-wide-default convention, same as every other branchId field
   * here) -> permission filter (§12, BEFORE ranking — an unauthorized
   * chunk never even reaches the ranker, let alone the LLM) -> rank ->
   * context assembly. Real popularity tracking: every chunk that actually
   * makes the top-K increments its retrievalCount.
   */
  static async retrieveKnowledge({ tenantId, branchId, role, permissions = [], query, topK, includeArchived = false }) {
    if (!query || !query.trim()) throw new Error("query is required.");
    const config = getAIKnowledgeConfig();

    const { embedding } = await AIEmbeddingService.generateEmbedding(query.trim());

    const filter = { tenantId, branchId: { $in: [branchId || "main", "main"] } };
    if (!includeArchived) filter.isActive = true;
    const candidates = await AIKnowledgeChunkModel.find(filter).lean();

    const authorized = candidates.filter((c) => this.hasKnowledgeAccess(c.visibilityLevel, { role, permissions }));
    if (authorized.length === 0) return { chunks: [], contextText: null, citations: [] };

    const ranked = this.rankChunks(authorized, embedding, query);
    const top = ranked.slice(0, topK || config.defaultTopK);

    if (top.length > 0 && mongoose.connection?.readyState === 1) {
      AIKnowledgeChunkModel.updateMany({ _id: { $in: top.map((t) => t._id) } }, { $inc: { retrievalCount: 1 } })
        .catch((err) => console.error("AI knowledge popularity counter update error:", err.message));
    }

    const { contextText, citations } = this.buildContextBlock(top, config.maxContextChars);
    return { chunks: top, contextText, citations };
  }
}

export default AIKnowledgeService;
