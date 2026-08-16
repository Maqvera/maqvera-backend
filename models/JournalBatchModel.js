import mongoose from "mongoose";

// "Batch Journal Processing" — File 2, Journal Platform Part 2, item 14.
// Real, synchronous batch creation (no message-queue/worker-pool
// infrastructure exists anywhere in this codebase — see
// docs/05-api/07-finance-api.md Part 39's own "explicitly out of scope"
// note) — a batch runs its journals in one request, partial-failure
// tolerant (one bad journal spec doesn't abort the rest), and records a
// real per-item error list rather than fabricating a queue/dead-letter
// mechanism. batchType is restricted to real journal-generating purposes
// (financeConfig.journalBatchTypes) — no Payroll/Subscription/Merchant
// Settlement/Depreciation/Interest batch types, since none of those
// modules exist in this codebase.
const JournalBatchSchema = new mongoose.Schema({
  tenantId: {
    type: String,
    required: true,
    index: true
  },
  batchNumber: {
    type: String,
    required: true,
    immutable: true
  },
  batchType: {
    type: String,
    required: true
  },
  // Processing, Completed, PartiallyCompleted, Failed.
  status: {
    type: String,
    default: "Processing",
    index: true
  },
  journalIds: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: "journal"
  }],
  totalCount: {
    type: Number,
    default: 0
  },
  succeededCount: {
    type: Number,
    default: 0
  },
  failedCount: {
    type: Number,
    default: 0
  },
  failedItems: [{
    index: { type: Number, required: true },
    message: { type: String, required: true }
  }],
  createdBy: { type: String, default: null },
  completedAt: { type: Date, default: null }
}, { timestamps: true });

JournalBatchSchema.index({ tenantId: 1, batchNumber: 1 }, { unique: true });

JournalBatchSchema.set("toJSON", {
  transform: (_, ret) => {
    delete ret.__v;
    return ret;
  }
});

const JournalBatchModel = mongoose.model("journal_batch", JournalBatchSchema);

export default JournalBatchModel;
