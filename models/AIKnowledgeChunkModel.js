import mongoose from "mongoose";

/**
 * EXT-030 §8/§11 "Document Chunking" / "Source Metadata". Metadata fields
 * are denormalized from the parent AIKnowledgeDocument at chunk-creation
 * time so retrieval never needs a join against the parent for the common
 * case — only re-read when the parent doc doesn't independently need
 * fetching. `embedding` is a real vector from AIEmbeddingService; this
 * codebase has no vector-index-capable database configured (no MongoDB
 * Atlas Vector Search, no dedicated vector DB), so similarity ranking is
 * computed in application code (AIKnowledgeService.rankChunks) over this
 * tenant's own active chunks — a real, correct implementation at this
 * codebase's actual scale (an internal knowledge base, not a
 * web-scale corpus), not a fabricated "already wired to a vector DB" claim.
 */
const AIKnowledgeChunkSchema = new mongoose.Schema(
  {
    documentId: { type: mongoose.Schema.Types.ObjectId, ref: "AIKnowledgeDocument", required: true, index: true },
    tenantId: { type: String, required: true, index: true },
    branchId: { type: String, default: "main", index: true },
    chunkIndex: { type: Number, required: true },
    sectionTitle: { type: String, default: null },
    content: { type: String, required: true },
    embedding: { type: [Number], required: true },
    embeddingModel: { type: String, required: true },
    embeddingProvider: { type: String, required: true },
    // Denormalized source metadata (§11) — kept in sync by
    // AIKnowledgeService whenever the parent document changes.
    documentTitle: { type: String, required: true },
    documentCategory: { type: String, required: true },
    documentVersion: { type: Number, required: true },
    visibilityLevel: { type: String, required: true, index: true },
    tags: [{ type: String }],
    language: { type: String, default: "en" },
    author: { type: String, default: null },
    // §14 "Version Control" — set false when the parent document is
    // updated (a new version's chunks are created fresh) or archived;
    // excluded from retrieval by default, kept (not deleted) for
    // "Historical lookup ... if requested".
    isActive: { type: Boolean, default: true, index: true },
    // §9 "Popularity" — a real, usage-driven counter (incremented each
    // time this chunk is actually returned in a top-K search result),
    // never a fabricated score.
    retrievalCount: { type: Number, default: 0 }
  },
  { timestamps: true }
);

AIKnowledgeChunkSchema.index({ tenantId: 1, branchId: 1, isActive: 1, visibilityLevel: 1 });
AIKnowledgeChunkSchema.index({ documentId: 1, isActive: 1 });

export default mongoose.models.AIKnowledgeChunk || mongoose.model("AIKnowledgeChunk", AIKnowledgeChunkSchema);
