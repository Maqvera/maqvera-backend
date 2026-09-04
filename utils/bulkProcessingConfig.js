import dotenv from "dotenv";

dotenv.config();

// Enterprise Subscription Automation Layer — Automation #8 (Enterprise
// Bulk Processing Engine). "Batch Size 500" / real, admin-configurable
// worker concurrency, retry, and lock settings — zero hardcoding, same
// env-override-with-real-default pattern as every other *Config.js in
// this codebase.
export const getBulkProcessingConfig = () => {
  return {
    // "Never load 100,000 companies into memory. Batch 500 -> Commit ->
    // Batch 2." Real MongoDB cursor batch size AND the real chunk size the
    // engine commits a checkpoint after.
    bulkProcessingBatchSize: parseInt(process.env.PLATFORM_BULK_PROCESSING_BATCH_SIZE || "500", 10),
    // "500 companies simultaneously process ho sakti hain." The real
    // bounded-concurrency worker pool size — genuine concurrent async I/O
    // within this one Node process (this codebase has no multi-process/
    // multi-machine worker infrastructure anywhere — same single-instance
    // scope already disclosed for `utils/eventBus.js`'s in-process
    // EventEmitter and `utils/resilienceEngine.js`'s in-memory circuit
    // breaker state), not literal OS threads or separate machines.
    bulkProcessingConcurrency: parseInt(process.env.PLATFORM_BULK_PROCESSING_CONCURRENCY || "20", 10),
    // Total attempts per merchant (including the first) before the item is
    // moved to the Dead Letter Queue — "Still Failed? -> Dead Letter Queue."
    bulkProcessingMaxAttempts: parseInt(process.env.PLATFORM_BULK_PROCESSING_MAX_ATTEMPTS || "3", 10),
    bulkProcessingRetryBackoffMs: parseInt(process.env.PLATFORM_BULK_PROCESSING_RETRY_BACKOFF_MS || "1000", 10),
    // "Distributed Lock... Already Locked? YES -> Skip." How long a lock
    // is held before being considered abandoned/stale and reclaimable —
    // must comfortably exceed the longest real bulk job this platform runs.
    bulkProcessingLockTtlMs: parseInt(process.env.PLATFORM_BULK_PROCESSING_LOCK_TTL_MS || "1800000", 10)
  };
};

export default getBulkProcessingConfig;
