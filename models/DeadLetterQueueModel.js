import mongoose from "mongoose";

// Enterprise Architecture Hardening Phase — Resilience & Reliability
// Standard (Improvement 6). "Agar retries ke baad bhi failure aaye...
// Dead Letter Queue mein safely store hoga. Operations team baad mein
// retry karegi." Real, durable record of a message that exhausted its
// retry budget — the spec's own example shape, plus what a real
// reprocessing workflow needs (`payload`, `manualRetryCount`).
const DeadLetterQueueSchema = new mongoose.Schema({
  tenantId: { type: String, default: null, index: true },
  module: { type: String, required: true, index: true },
  operation: { type: String, required: true },
  integration: { type: String, required: true, index: true },
  reason: { type: String, required: true },
  retryAttempts: { type: Number, required: true },
  correlationId: { type: String, default: null, index: true },
  idempotencyKey: { type: String, default: null },
  // The original request data needed to actually retry the operation —
  // without this a DLQ row is just a historical record, not something
  // Operations can act on.
  payload: { type: mongoose.Schema.Types.Mixed, default: null },
  // Config-driven (dlqStatuses) — Pending, Reprocessing, Recovered, PermanentFailure.
  status: { type: String, required: true, index: true },
  manualRetryCount: { type: Number, default: 0 },
  failedAt: { type: Date, required: true },
  reprocessedAt: { type: Date, default: null },
  reprocessedBy: { type: String, default: null },
  timeline: [{
    event: { type: String, required: true },
    description: { type: String, default: null },
    performedBy: { type: String, default: null },
    performedAt: { type: Date, default: Date.now }
  }]
}, { timestamps: true, optimisticConcurrency: true });

DeadLetterQueueSchema.index({ tenantId: 1, status: 1, createdAt: -1 });
DeadLetterQueueSchema.index({ integration: 1, status: 1 });

DeadLetterQueueSchema.set("toJSON", {
  transform: (_, ret) => {
    delete ret.__v;
    return ret;
  }
});

const DeadLetterQueueModel = mongoose.model("dead_letter_queue", DeadLetterQueueSchema);

export default DeadLetterQueueModel;
