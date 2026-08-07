import dotenv from "dotenv";
dotenv.config();

const parseNumber = (value, fallback) => {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const parseFloatSafe = (value, fallback) => {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const parseJson = (value, fallback) => {
  if (!value) return fallback;
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : fallback;
  } catch {
    return fallback;
  }
};

/**
 * EXT-030 "AI Knowledge & Context Retrieval (RAG Layer)" configuration.
 * Config-driven per this codebase's own convention (see CLAUDE.md
 * "Config-driven domain values") rather than hardcoded arrays in a
 * service/controller.
 */
export const getAIKnowledgeConfig = () => ({
  // §5 "Knowledge Sources" — the doc's own list, made config-driven so a
  // new category doesn't need a code change.
  categories: parseJson(process.env.AI_KNOWLEDGE_CATEGORIES_JSON, [
    "SOP", "TravelPolicy", "VisaRule", "HotelPolicy", "AirlinePolicy", "RefundPolicy",
    "PackageDescription", "InternalDocumentation", "FAQ", "TrainingManual",
    "OperationalPlaybook", "EmergencyProcedure", "TravelContract", "KnowledgeBaseArticle", "ProductDocumentation"
  ]),

  // §6 "Knowledge Levels — Public, Internal, Operations, Management,
  // Executive." Ordered low->high; a caller who can see a given tier can
  // also see every tier below it (see AIKnowledgeService.hasKnowledgeAccess).
  // Deliberately a SEPARATE role vocabulary from AIToolRegistry.js's own
  // MANAGEMENT_ROLES — that gates TOOL EXECUTION, this gates KNOWLEDGE
  // CONTENT visibility; the two happen to share role names by convention,
  // not by a shared code dependency, and are independently configurable.
  operationsRoles: parseJson(process.env.AI_KNOWLEDGE_OPERATIONS_ROLES_JSON, ["operations", "agent", "coordinator", "supervisor", "staff"]),
  managementRoles: parseJson(process.env.AI_KNOWLEDGE_MANAGEMENT_ROLES_JSON, ["manager", "management", "finance", "compliance"]),
  executiveRoles: parseJson(process.env.AI_KNOWLEDGE_EXECUTIVE_ROLES_JSON, ["executive", "director", "ceo", "board"]),

  // §8 "Document Chunking — Chunk size configurable. Overlap configurable."
  chunkSizeChars: parseNumber(process.env.AI_KNOWLEDGE_CHUNK_SIZE_CHARS, 1200),
  chunkOverlapChars: parseNumber(process.env.AI_KNOWLEDGE_CHUNK_OVERLAP_CHARS, 150),

  // §21 "Future Ready — OpenAI Embeddings, Azure OpenAI, ..." Only these
  // two are real here — both reuse this codebase's own already-configured
  // `openai` SDK client (see AIEmbeddingService), the same honesty
  // boundary AI_SECONDARY_PROVIDER etc. already draw in utils/aiConfig.js.
  embeddingProvider: process.env.AI_EMBEDDING_PROVIDER || "OpenAI",
  embeddingModel: process.env.AI_EMBEDDING_MODEL || "text-embedding-3-small",
  // Azure OpenAI requires its OWN deployment name for an embedding model —
  // distinct from AZURE_OPENAI_DEPLOYMENT (that one is the CHAT model).
  azureEmbeddingDeployment: process.env.AZURE_OPENAI_EMBEDDING_DEPLOYMENT || null,

  // §9 "Ranking Strategy" weights — a real weighted composite score
  // (mirrors services/ai/AIRankingService.js's existing pattern for
  // flight/hotel offers), not a single raw cosine-similarity number.
  rankingWeights: {
    semantic: parseFloatSafe(process.env.AI_KNOWLEDGE_WEIGHT_SEMANTIC, 0.6),
    keyword: parseFloatSafe(process.env.AI_KNOWLEDGE_WEIGHT_KEYWORD, 0.15),
    title: parseFloatSafe(process.env.AI_KNOWLEDGE_WEIGHT_TITLE, 0.1),
    tag: parseFloatSafe(process.env.AI_KNOWLEDGE_WEIGHT_TAG, 0.05),
    freshness: parseFloatSafe(process.env.AI_KNOWLEDGE_WEIGHT_FRESHNESS, 0.05),
    popularity: parseFloatSafe(process.env.AI_KNOWLEDGE_WEIGHT_POPULARITY, 0.05)
  },

  // §13 "Context Window — Maximum context size configurable. Older chunks
  // removed first. Higher ranked knowledge retained."
  maxContextChars: parseNumber(process.env.AI_KNOWLEDGE_MAX_CONTEXT_CHARS, 6000),
  defaultTopK: parseNumber(process.env.AI_KNOWLEDGE_DEFAULT_TOP_K, 5),

  // §17 "Supported Knowledge Types" — real, installed extractors only
  // (pdf-parse, mammoth, html-to-text); a type outside this list is
  // honestly rejected at upload, never silently mishandled.
  allowedUploadMimeTypes: [
    "application/pdf",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "text/html",
    "text/plain",
    "text/markdown",
    "application/json"
  ],
  maxUploadFileSizeBytes: parseNumber(process.env.AI_KNOWLEDGE_MAX_UPLOAD_BYTES, 10 * 1024 * 1024)
});

export default getAIKnowledgeConfig;
