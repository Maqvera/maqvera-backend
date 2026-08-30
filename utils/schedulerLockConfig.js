// Production Readiness Audit — Phase 1 / Item 1 (scheduler duplication
// under horizontal scaling). One shared, configurable lock TTL for every
// `services/*Scheduler.js` cron job — same env-driven-config-with-fallback
// convention as utils/bulkProcessingConfig.js's own bulkProcessingLockTtlMs
// (the one scheduler-adjacent lock TTL that already existed before this
// pass). A single shared default is enough here: every job in this list is
// a lightweight cron tick (find + loop + save, or a handful of DB writes)
// — anything genuinely heavy already goes through
// services/BulkProcessingEngineService.js, which has its own
// PLATFORM_BULK_PROCESSING_LOCK_TTL_MS. 10 minutes comfortably exceeds any
// of these jobs' real runtime while still releasing a stale lock from a
// crashed instance well before the next tick (most of these run hourly or
// less often).
export const getSchedulerLockConfig = () => ({
  defaultLockTtlMs: parseInt(process.env.SCHEDULER_LOCK_TTL_MS || "600000", 10)
});
