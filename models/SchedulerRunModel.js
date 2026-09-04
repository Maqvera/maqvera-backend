import mongoose from "mongoose";

// Enterprise Subscription Automation Layer — Automation #1: Enterprise
// Subscription Scheduler. "Every execution should create a run record."
// Platform-level operational data, deliberately NOT tenant-owned (a run
// scans across every tenant in one pass) — same precedent as
// AuditLogModel rows created with `tenantId: null` for cross-tenant
// platform actions (see TenantSubscriptionService.generateConsolidatedInvoice).
// Generic across job names on purpose — this is the one real run-record
// shape both the daily lifecycle sweep and the more frequent suspension
// enforcement job write to, rather than a per-job table each.
const SchedulerRunSchema = new mongoose.Schema({
  jobId: { type: String, required: true, unique: true },
  jobName: { type: String, required: true, index: true },
  // Running -> Completed | Failed. Real lifecycle, not a boolean —
  // a run record is created at start (Running) so a crash mid-run still
  // leaves a real, honest, permanently-Running-until-investigated row
  // rather than no record at all.
  status: { type: String, required: true, enum: ["Running", "Completed", "Failed"], default: "Running", index: true },
  triggeredBy: { type: String, enum: ["cron", "manual"], default: "cron" },
  startedAt: { type: Date, required: true, default: Date.now, index: true },
  finishedAt: { type: Date, default: null },
  durationMs: { type: Number, default: null },
  // Real per-outcome counters — same field names
  // TenantSubscriptionService.runDailyLifecycleSweep's own `results`
  // object has always returned, so one object shape serves both the
  // in-memory return value callers already depend on AND this persisted
  // record, with zero renaming/drift risk.
  processed: { type: Number, default: 0 },
  // Automation #2 (Enterprise Automatic Renewal Engine) — real count of
  // subscriptions successfully auto-renewed this run. 0/unused for any
  // other job (Automation #1's own daily sweep/suspension enforcement).
  renewed: { type: Number, default: 0 },
  invoicesGenerated: { type: Number, default: 0 },
  remindersSent: { type: Number, default: 0 },
  gracePeriodsStarted: { type: Number, default: 0 },
  suspended: { type: Number, default: 0 },
  expired: { type: Number, default: 0 },
  archived: { type: Number, default: 0 },
  failed: { type: Number, default: 0 },
  errorMessage: { type: String, default: null }
}, { timestamps: true });

SchedulerRunSchema.index({ jobName: 1, startedAt: -1 });

SchedulerRunSchema.set("toJSON", {
  transform: (_, ret) => {
    delete ret.__v;
    return ret;
  }
});

const SchedulerRunModel = mongoose.model("scheduler_run", SchedulerRunSchema);

export default SchedulerRunModel;
