import mongoose from "mongoose";

// Enterprise Subscription Automation Layer — Automation #8 (Enterprise
// Bulk Processing Engine). "Checkpoint Recovery... System ko yaad hona
// chahiye Processed 850, Remaining 150, Continue From 851." The real,
// persisted job record `services/BulkProcessingEngineService.js` writes to
// after EVERY batch (never only at the end) — `lastCheckpointId` is the
// last processed document's own `_id` (cursor sorted ascending by `_id`,
// so it is a real, resumable offset), letting a genuinely interrupted job
// be identified and resumed from where it left off rather than restarted
// from the beginning. Deliberately separate from `models/SchedulerRunModel.js`
// (the outer "this cron fired and did X" record every scheduler already
// writes) — this is the inner, per-item-observable record of one real
// bulk queue/batch/worker-pool run, matching the spec's own architecture
// diagram (Scheduler -> Scanner -> Job Queue -> Worker Pool -> Results).
const BulkProcessingJobSchema = new mongoose.Schema({
  jobId: { type: String, required: true, unique: true },
  // e.g. "GracePeriodSuspensionSweep" — generic across job types on
  // purpose, same precedent as SchedulerRunModel's own generic `jobName`.
  jobType: { type: String, required: true, index: true },
  status: { type: String, required: true, enum: ["Running", "Completed", "PartiallyFailed", "Failed"], default: "Running", index: true },
  triggeredBy: { type: String, enum: ["cron", "manual"], default: "cron" },
  // Real configuration snapshot used for THIS run — batch size / worker
  // concurrency are admin-configurable (utils/bulkProcessingConfig.js) and
  // can change between runs; the row that ran under a given setting should
  // say so, not just report the current config.
  batchSize: { type: Number, required: true },
  concurrency: { type: Number, required: true },
  totalDiscovered: { type: Number, default: 0 },
  processed: { type: Number, default: 0 },
  succeeded: { type: Number, default: 0 },
  failed: { type: Number, default: 0 },
  retried: { type: Number, default: 0 },
  skipped: { type: Number, default: 0 },
  deadLettered: { type: Number, default: 0 },
  lastCheckpointId: { type: String, default: null },
  startedAt: { type: Date, required: true, default: Date.now, index: true },
  finishedAt: { type: Date, default: null },
  durationMs: { type: Number, default: null },
  errorMessage: { type: String, default: null }
}, { timestamps: true });

BulkProcessingJobSchema.index({ jobType: 1, startedAt: -1 });

BulkProcessingJobSchema.set("toJSON", {
  transform: (_, ret) => {
    delete ret.__v;
    return ret;
  }
});

const BulkProcessingJobModel = mongoose.model("bulk_processing_job", BulkProcessingJobSchema);

export default BulkProcessingJobModel;
