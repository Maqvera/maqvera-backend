import multer from "multer";
import AIKnowledgeService from "../services/AIKnowledgeService.js";
import AIKnowledgeExtractionService from "../services/ai/AIKnowledgeExtractionService.js";
import { getAIKnowledgeConfig } from "../utils/aiKnowledgeConfig.js";
import { sendError, sendSuccess } from "../utils/apiResponse.js";
import { createRequestId } from "../utils/authTokens.js";

const AI_PERMISSION = "ai.assistant.use";
const KNOWLEDGE_MANAGE_PERMISSION = "ai.knowledge.manage";

const buildContext = (req) => ({
  tenantId: req.auth?.tenantId || "default",
  branchId: req.auth?.branchId || "main",
  userId: req.auth?.userId || req.auth?.id,
  userName: req.auth?.name || "User",
  permissions: req.auth?.permissions || [],
  role: req.auth?.role || req.auth?.roles?.[0] || ""
});

const hasAIAccess = (permissions) => permissions.includes(AI_PERMISSION) || permissions.includes("admin");
// Authoring/editing company SOPs/policies is a distinct, narrower
// capability than merely using the AI assistant — any staff member who
// can chat with the AI should not automatically be able to rewrite what
// it treats as company policy.
const hasKnowledgeManageAccess = (permissions) => permissions.includes(KNOWLEDGE_MANAGE_PERMISSION) || permissions.includes("admin");

// EXT-030 §17 "Supported Knowledge Types". A dedicated multer instance,
// separate from services/FileUploadService.js — that one persists uploads
// to cloud/local storage for later download (identity documents etc.);
// knowledge documents only need their TEXT extracted for chunking/
// embedding, so memoryStorage is used and the raw buffer is discarded
// after extraction, never written to disk or cloud storage.
const { allowedUploadMimeTypes, maxUploadFileSizeBytes } = getAIKnowledgeConfig();
export const uploadKnowledgeFile = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: maxUploadFileSizeBytes },
  fileFilter: (_req, file, cb) => {
    if (allowedUploadMimeTypes.includes(file.mimetype)) return cb(null, true);
    cb(new Error(`File type ${file.mimetype} is not supported. Allowed: ${allowedUploadMimeTypes.join(", ")}.`), false);
  }
}).single("file");

/** 1. POST /api/v1/ai/knowledge — create from either a JSON `content` body or an uploaded file (multipart `file` field). */
export const CreateKnowledgeDocument = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const ctx = buildContext(req);
    if (!hasKnowledgeManageAccess(ctx.permissions)) return sendError(res, 403, "Permission denied.", requestId);

    const { title, category, visibilityLevel, tags, language, author } = req.body;
    let { content } = req.body;
    let sourceType = "text";
    let sourceFileName = null;

    if (req.file) {
      sourceType = AIKnowledgeExtractionService.sourceTypeForMime(req.file.mimetype);
      sourceFileName = req.file.originalname;
      content = await AIKnowledgeExtractionService.extractText(req.file.buffer, req.file.mimetype);
    }

    if (!content || !content.trim()) return sendError(res, 400, "content (or an uploaded file with extractable text) is required.", requestId);
    if (!category) return sendError(res, 400, "category is required.", requestId);

    const parsedTags = typeof tags === "string" ? tags.split(",").map((t) => t.trim()).filter(Boolean) : (Array.isArray(tags) ? tags : []);

    const result = await AIKnowledgeService.createDocument({
      tenantId: ctx.tenantId, branchId: ctx.branchId, userId: ctx.userId,
      title, category, visibilityLevel, content, tags: parsedTags, language, author,
      sourceType, sourceFileName
    });
    return sendSuccess(res, 201, "Knowledge document created and indexed successfully.", { document: result.document, chunkCount: result.chunkCount }, requestId);
  } catch (err) {
    console.error("CreateKnowledgeDocument Error:", err);
    const statusCode = err.code === "AI_UNAVAILABLE" ? 503 : (err.message?.includes("required") || err.message?.includes("Invalid knowledge category")) ? 400 : 500;
    return sendError(res, statusCode, err.message || "Failed to create knowledge document.", requestId);
  }
};

/** 2. PUT /api/v1/ai/knowledge/:documentId */
export const UpdateKnowledgeDocument = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const ctx = buildContext(req);
    if (!hasKnowledgeManageAccess(ctx.permissions)) return sendError(res, 403, "Permission denied.", requestId);

    const { title, category, visibilityLevel, content, tags, language, author } = req.body;
    const parsedTags = tags == null ? undefined : (typeof tags === "string" ? tags.split(",").map((t) => t.trim()).filter(Boolean) : tags);

    const result = await AIKnowledgeService.updateDocument({
      tenantId: ctx.tenantId, userId: ctx.userId, documentId: req.params.documentId,
      title, category, visibilityLevel, content, tags: parsedTags, language, author
    });
    return sendSuccess(res, 200, "Knowledge document updated successfully.", { document: result.document, chunkCount: result.chunkCount }, requestId);
  } catch (err) {
    console.error("UpdateKnowledgeDocument Error:", err);
    const statusCode = err.message?.includes("not found") ? 404 : err.code === "AI_UNAVAILABLE" ? 503 : err.message?.includes("Invalid knowledge category") || err.message?.includes("cannot be updated") ? 400 : 500;
    return sendError(res, statusCode, err.message || "Failed to update knowledge document.", requestId);
  }
};

/** 3. DELETE /api/v1/ai/knowledge/:documentId — archives (soft), never hard-deletes; matches EXT-030 §14 "Historical lookup ... if requested". */
export const ArchiveKnowledgeDocument = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const ctx = buildContext(req);
    if (!hasKnowledgeManageAccess(ctx.permissions)) return sendError(res, 403, "Permission denied.", requestId);
    const doc = await AIKnowledgeService.archiveDocument({ tenantId: ctx.tenantId, userId: ctx.userId, documentId: req.params.documentId });
    return sendSuccess(res, 200, "Knowledge document archived successfully.", doc, requestId);
  } catch (err) {
    console.error("ArchiveKnowledgeDocument Error:", err);
    return sendError(res, err.message?.includes("not found") ? 404 : err.message?.includes("already") ? 409 : 500, err.message || "Failed to archive knowledge document.", requestId);
  }
};

/** 4. GET /api/v1/ai/knowledge */
export const ListKnowledgeDocuments = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const ctx = buildContext(req);
    if (!hasAIAccess(ctx.permissions)) return sendError(res, 403, "Permission denied.", requestId);
    const result = await AIKnowledgeService.listDocuments({
      tenantId: ctx.tenantId, branchId: ctx.branchId, category: req.query.category,
      status: req.query.status || "active", page: req.query.page, pageSize: req.query.pageSize
    });
    return sendSuccess(res, 200, "Knowledge documents retrieved successfully.", result, requestId);
  } catch (err) {
    console.error("ListKnowledgeDocuments Error:", err);
    return sendError(res, 500, err.message || "Failed to list knowledge documents.", requestId);
  }
};

/** 5. GET /api/v1/ai/knowledge/:documentId */
export const GetKnowledgeDocumentById = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const ctx = buildContext(req);
    if (!hasAIAccess(ctx.permissions)) return sendError(res, 403, "Permission denied.", requestId);
    const doc = await AIKnowledgeService.getDocumentById({ tenantId: ctx.tenantId, documentId: req.params.documentId });
    return sendSuccess(res, 200, "Knowledge document retrieved successfully.", doc, requestId);
  } catch (err) {
    console.error("GetKnowledgeDocumentById Error:", err);
    return sendError(res, err.message?.includes("not found") ? 404 : 500, err.message || "Failed to retrieve knowledge document.", requestId);
  }
};

/** 6. POST /api/v1/ai/knowledge/search — direct, permission-filtered semantic search; the same retrieval AIToolRegistry.js's search_knowledge_base tool uses internally. */
export const SearchKnowledgeBase = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const ctx = buildContext(req);
    if (!hasAIAccess(ctx.permissions)) return sendError(res, 403, "Permission denied.", requestId);
    const { query, topK, includeArchived } = req.body;
    if (!query) return sendError(res, 400, "query is required.", requestId);

    const result = await AIKnowledgeService.retrieveKnowledge({
      tenantId: ctx.tenantId, branchId: ctx.branchId, role: ctx.role, permissions: ctx.permissions,
      query, topK, includeArchived: Boolean(includeArchived)
    });
    return sendSuccess(res, 200, "Knowledge search completed successfully.", result, requestId);
  } catch (err) {
    console.error("SearchKnowledgeBase Error:", err);
    const statusCode = err.code === "AI_UNAVAILABLE" ? 503 : err.message?.includes("required") ? 400 : 500;
    return sendError(res, statusCode, err.message || "Failed to search knowledge base.", requestId);
  }
};
