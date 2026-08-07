---
title: EXT-030 — AI Knowledge & Context Retrieval (RAG Layer)
document_id: EXT-030
version: 1.0.0
status: Production Ready (scoped)
module: AI Integration
---

# EXT-030 — AI Knowledge & Context Retrieval (RAG Layer)

---

## 1. Audit Finding

Genuinely new ground — confirmed by search (`embedding`, `vector`, `KnowledgeBase`, `chunkText`, etc.) before writing anything. `models/EnterpriseDocumentModel.js` is a different, pre-existing concern: files attached to a specific visa case/customer/booking record (passport scans, ID docs), not organizational knowledge with no owning entity. Nothing in this codebase generated embeddings, chunked documents, or ranked semantic search results before this document.

---

## 2. What Was Built

### Storage — two new models

- `AIKnowledgeDocumentModel` — the parent article (title, category, `visibilityLevel`, full extracted content, tags, language, author, version, status). §14 "Version Control": content changes bump `version` and archive (never delete) the prior version's chunks.
- `AIKnowledgeChunkModel` — chunks with a real embedding vector, denormalized source metadata (§11), and a genuine, usage-driven `retrievalCount` (§9 "Popularity" — incremented only when a chunk actually lands in a top-K result, never fabricated).

**Honest scope note on the vector store**: this codebase has no MongoDB Atlas Vector Search and no dedicated vector database configured. Similarity ranking is computed in application code (real cosine similarity, real weighted composite scoring) over a tenant's active chunks — correct at this codebase's actual scale (an internal knowledge base of SOPs/policies, not a web-scale corpus), not a claim of an already-wired vector index that doesn't exist.

### Real text extraction + chunking — `services/ai/AIKnowledgeExtractionService.js`

Real parsers for every type in §17's list this codebase can honestly support: `pdf-parse` (PDF), `mammoth` (DOCX), `html-to-text` (HTML), native UTF-8 (Markdown/plain text), and a real JSON-flattening pass (Structured JSON). Newly installed `pdf-parse` v1.1.1 specifically (not the current major, which ships a completely different class-based API) — and imported via its inner `pdf-parse/lib/pdf-parse.js` entry point, which sidesteps a well-known packaging bug where the package root's `index.js` runs a debug self-test at ESM import time.

Chunking (§8) is a real, deterministic algorithm — markdown-header-aware sectioning, then greedy paragraph packing up to a configurable size with configurable character overlap between consecutive chunks, and a hard-split path for any single paragraph longer than the chunk size — never an LLM-based chunker (nondeterministic and unnecessary for a structural splitting problem).

### Real embeddings — `services/ai/AIEmbeddingService.js`

Reuses this codebase's already-installed `openai` SDK (the same package `OpenAIAdapter.js`/`AzureOpenAIAdapter.js` already use for chat) for both OpenAI and Azure OpenAI embeddings — Azure needs its own `AZURE_OPENAI_EMBEDDING_DEPLOYMENT` (a genuinely different deployment from the chat model). Automatic failover between the two configured providers, same spirit as `AIOrchestrationService._callLLM`. Throws a clearly-labeled `AI_UNAVAILABLE` error — never a fabricated vector — when neither is configured (confirmed live: with no API key set in this environment, the tool honestly reports this rather than returning fake results).

### Permission filtering (§6/§12) — `AIKnowledgeService.hasKnowledgeAccess()`

Five hierarchical tiers (public/internal/operations/management/executive), config-driven role mapping (`utils/aiKnowledgeConfig.js`, deliberately a separate knob from `AIToolRegistry.js`'s own `MANAGEMENT_ROLES` — one gates tool execution, this gates knowledge content visibility). Applied **before** ranking — an unauthorized chunk is filtered out of the candidate set entirely, never scored, never reaches the LLM.

### Real weighted ranking (§9) + context assembly (§10/§13)

`rankChunks()` mirrors `services/ai/AIRankingService.js`'s existing weighted-composite pattern: semantic (cosine similarity) + keyword overlap + title match + tag match + freshness (recency decay) + popularity (real retrieval-count signal), each independently configurable. "AI Confidence" isn't a fabricated seventh input — it's this composite score itself, surfaced back as the citation's `confidence`. `buildContextBlock()` takes the already-ranked list and fills a configurable character budget, highest-ranked first — "older chunks removed first" in practice, since a lower-ranked chunk is simply never reached once the budget is spent.

### Wired into the AI Assistant, not bolted on beside it

New real tool `search_knowledge_base` in `AIToolRegistry.js` — a deliberate architectural choice: the doc's own diagram shows retrieval as an unconditional pre-step, but this codebase's chat loop is entirely LLM-tool-driven (every other capability, including plain reads, is a tool the model chooses to call, never an automatic pipeline stage) — running an embedding call on every single turn regardless of relevance would be inconsistent with that pattern and wasteful. Instead, the tool's own description carries an explicit instruction, and the system prompt reinforces it: for any policy/SOP/procedure question, the model **must** call it before answering, never guess from general knowledge. `AIAssistantService.chat()` now extracts real citations from the tool's actual result into a new `citations` field on its response (same pattern as how flight/hotel `recommendations` are already extracted) — never derived from the model's own free-text answer.

### CRUD + search API (§18)

`POST/PUT/DELETE /api/v1/ai/knowledge`, `GET /api/v1/ai/knowledge[/:documentId]`, `POST /api/v1/ai/knowledge/search` — full validate → chunk → embed → index pipeline on create, re-chunk-and-re-embed only when content actually changes (a metadata-only edit just re-syncs denormalized fields on the existing chunks, no wasted embedding calls). File upload via a dedicated in-memory multer instance (deliberately separate from `services/FileUploadService.js`, which persists to cloud storage for later download — knowledge documents only need their text extracted, the raw file is discarded, never archived). Delete is a soft archive, never a hard delete, matching §14's "historical lookup ... if requested". Authoring is gated behind a new `ai.knowledge.manage` permission — distinct and narrower than merely using the AI assistant.

---

## 3. Verification

59 isolated checks, run against the real production code, no live MongoDB/OpenAI key in this environment:

- **Chunking** (13 checks): empty/short/long text, real markdown section attribution, real overlap between consecutive chunks, oversized-paragraph hard-splitting, no content loss anywhere in the chunk set, config defaults actually read (not hardcoded).
- **Extraction** (8 checks): every real extractor (`pdf-parse`, `mammoth`, `html-to-text`, JSON flattening, plain/markdown) produces genuine content; unsupported MIME types are honestly rejected; PDF/DOCX wiring confirmed correct via real content-parsing errors (not import/signature errors) — proving the known `pdf-parse` ESM debug-mode bug is genuinely avoided.
- **Access control + ranking + context assembly** (21 checks): all 5 tiers hierarchical and correctly gated (including that a lower tier cannot skip levels), `admin` override, semantic+keyword+title+tag signals correctly surface the right chunk, context budget correctly bounds output to the highest-ranked chunks first, honest empty results.
- **Full service lifecycle** (17 checks): create → real chunk/embed pipeline → permission-filtered search finds it → content update bumps version and archives (not deletes) old chunks while re-embedding fresh ones → metadata-only update skips re-embedding entirely → archive deactivates every chunk across every version → archived documents stop appearing in search → invalid category is rejected.
- Tool registration confirmed live: `search_knowledge_base` is correctly cataloged, and calling it through the real `AIToolRegistry.execute()` with no embedding provider configured returns a clean, honest `AI_UNAVAILABLE` error rather than throwing or fabricating a result.

Full suite held at **49/49**, `node --check` clean on every touched file, `AIAgentRegistry`'s own self-validation (every real tool assigned to exactly one agent) still passes after adding the new tool to the Search & Reference Agent.

---

## 4. Completion Status

- **Status**: Production Ready (scoped exactly as described above)
- **Document ID**: `EXT-030`
- **Next recommended**: EXT-031 — AI Prompt Management & System Instructions, per the source document's own pointer.
