import mongoose from "mongoose";

/**
 * EXT-030 §5/§11/§14 "Knowledge Sources" / "Source Metadata" / "Version
 * Control". The parent knowledge article (SOP, policy, FAQ, ...) — NOT the
 * same concern as models/EnterpriseDocumentModel.js, which stores files
 * attached to a specific visa case/customer/booking record (passport
 * scans, ID docs). This has no owning entity; it's organizational
 * knowledge the AI retrieves to answer questions, never edited by the AI
 * itself (EXT-030 §3 "Not Responsible For: Editing Documents").
 */
const AIKnowledgeDocumentSchema = new mongoose.Schema(
  {
    tenantId: { type: String, required: true, index: true },
    branchId: { type: String, default: "main", index: true },
    title: { type: String, required: true },
    category: { type: String, required: true, index: true },
    // §6 "Knowledge Levels" — see utils/aiKnowledgeConfig.js for the real
    // role mapping enforced against this at retrieval time.
    visibilityLevel: { type: String, enum: ["public", "internal", "operations", "management", "executive"], default: "internal", index: true },
    // The full extracted plain-text content this document's chunks were
    // generated from — kept for re-chunking on update/re-embedding-model
    // migration, and for an admin to review exactly what the AI can see.
    content: { type: String, required: true },
    sourceType: { type: String, enum: ["text", "pdf", "docx", "html", "json"], default: "text" },
    sourceFileName: { type: String, default: null },
    tags: [{ type: String }],
    language: { type: String, default: "en" },
    author: { type: String, default: null },
    // §14 "Version Control — Only active document versions retrieved.
    // Archived documents excluded by default." Bumped on every content
    // update; the OLD version's chunks are archived (see
    // AIKnowledgeChunkModel), never deleted, for "Historical lookup...
    // if requested".
    version: { type: Number, default: 1 },
    status: { type: String, enum: ["active", "archived"], default: "active", index: true },
    createdBy: { type: String, required: true },
    updatedBy: { type: String, default: null },
    archivedAt: { type: Date, default: null }
  },
  { timestamps: true }
);

AIKnowledgeDocumentSchema.index({ tenantId: 1, branchId: 1, status: 1, category: 1 });

export default mongoose.models.AIKnowledgeDocument || mongoose.model("AIKnowledgeDocument", AIKnowledgeDocumentSchema);
