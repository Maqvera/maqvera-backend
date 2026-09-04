import test, { after } from "node:test";
import assert from "node:assert/strict";
import dotenv from "dotenv";
import mongoose from "mongoose";

dotenv.config();

// Gap 1.4 "RAG similarity search has no dedicated vector index" — not a
// vector-DB migration (explicitly out of scope per the PRD until a real
// scaling concern shows up), just the missing measurement: how many chunks
// AIKnowledgeService.retrieveKnowledge's in-app cosine-similarity scan
// actually considers per call, now persisted (AIRequestMetricModel.ragChunksScanned,
// an existing collection — no new one needed) and surfaced
// (AIObservabilityService.getRAGMetrics().averageChunksScanned).

let dbAvailable = false;
const uri = process.env.URI || process.env.MONGO_URI;
if (uri) {
  try {
    await mongoose.connect(uri, { serverSelectionTimeoutMS: 8000 });
    dbAvailable = mongoose.connection.readyState === 1;
  } catch {
    dbAvailable = false;
  }
}

const dbSkipReason = "No reachable MongoDB configured (set URI in .env) — skipping live integration test.";

test("AIKnowledgeService.retrieveKnowledge reports scannedCount = the number of active, tenant-scoped chunks considered", { skip: !dbAvailable && dbSkipReason }, async (t) => {
  const AIKnowledgeChunkModel = (await import("../models/AIKnowledgeChunkModel.js")).default;
  const AIKnowledgeService = (await import("../services/AIKnowledgeService.js")).default;
  const AIEmbeddingService = (await import("../services/ai/AIEmbeddingService.js")).default;

  const suffix = Date.now();
  const tenantId = `test-rag-scan-${suffix}`;
  t.after(async () => { await AIKnowledgeChunkModel.deleteMany({ tenantId }); });

  // No embedding provider is configured in this test environment (no
  // OPENAI_API_KEY) — stub the one external call so this test never makes a
  // live LLM request, matching this codebase's own "test with a mocked
  // transport, not a live call" standard elsewhere. Both AIKnowledgeService
  // and this test import the same singleton class, so reassigning the
  // static method here is visible to the call made inside retrieveKnowledge.
  const originalGenerateEmbedding = AIEmbeddingService.generateEmbedding;
  const fakeEmbedding = [0.1, 0.2, 0.3, 0.4];
  AIEmbeddingService.generateEmbedding = async () => ({ embedding: fakeEmbedding, model: "test-model", provider: "test" });
  t.after(() => { AIEmbeddingService.generateEmbedding = originalGenerateEmbedding; });

  const makeChunk = (i) => ({
    documentId: new mongoose.Types.ObjectId(), tenantId, chunkIndex: i,
    content: `Test policy content ${i}`, embedding: fakeEmbedding, embeddingModel: "test-model", embeddingProvider: "test",
    documentTitle: `Doc ${i}`, documentCategory: "Policy", documentVersion: 1, visibilityLevel: "public", isActive: true
  });
  await AIKnowledgeChunkModel.insertMany([makeChunk(1), makeChunk(2), makeChunk(3)]);
  // An inactive chunk must NOT be counted as scanned — retrieveKnowledge only queries isActive:true by default.
  await AIKnowledgeChunkModel.create({ ...makeChunk(4), isActive: false });

  const result = await AIKnowledgeService.retrieveKnowledge({ tenantId, role: "agent", permissions: ["ai.chat"], query: "test policy" });
  assert.equal(result.scannedCount, 3, "scannedCount must equal the number of ACTIVE chunks found for this tenant, excluding the inactive one");
});

test("AIObservabilityService.getRAGMetrics computes averageChunksScanned from ragChunksScanned, distinct from averageRetrievedChunks", { skip: !dbAvailable && dbSkipReason }, async (t) => {
  const AIRequestMetricModel = (await import("../models/AIRequestMetricModel.js")).default;
  const AIObservabilityService = (await import("../services/ai/AIObservabilityService.js")).default;

  const suffix = Date.now();
  const tenantId = `test-rag-metrics-${suffix}`;
  t.after(async () => { await AIRequestMetricModel.deleteMany({ tenantId }); });

  await AIRequestMetricModel.create({ tenantId, type: "chat", succeeded: true, ragUsed: true, ragHit: true, ragChunkCount: 2, ragCitationCount: 2, ragChunksScanned: 40 });
  await AIRequestMetricModel.create({ tenantId, type: "chat", succeeded: true, ragUsed: true, ragHit: true, ragChunkCount: 4, ragCitationCount: 4, ragChunksScanned: 60 });
  // A request that never touched the knowledge base must not dilute the average.
  await AIRequestMetricModel.create({ tenantId, type: "chat", succeeded: true, ragUsed: false });

  const metrics = await AIObservabilityService.getRAGMetrics({ tenantId });
  assert.equal(metrics.retrievals, 2);
  assert.equal(metrics.averageChunksScanned, 50, "average of 40 and 60");
  assert.equal(metrics.averageRetrievedChunks, 3, "average of 2 and 4 — distinct from the scanned count");
});

after(async () => {
  if (dbAvailable) await mongoose.disconnect();
});
