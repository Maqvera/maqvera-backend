import mongoose from "mongoose";

// General Journal — Finance Module Part 3. Every financial transaction,
// automatic or manual, passes through here before posting to the
// (immutable) General Ledger. Tenant-scoped only — no branchId (see
// docs/06-external-integrations/03-final-architecture-no-branches-rbac.md).
const JournalLineSchema = new mongoose.Schema({
  accountId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "chart_of_account",
    required: true
  },
  // Snapshot of the account code at posting time — the account name/code
  // can change later (Part 2 allows editing `name`), but a journal line
  // must keep reading the way it did when it was created.
  accountCode: {
    type: String,
    required: true
  },
  debit: {
    type: Number,
    default: 0,
    min: 0
  },
  credit: {
    type: Number,
    default: 0,
    min: 0
  },
  description: {
    type: String,
    default: null
  }
}, { _id: true });

const JournalSchema = new mongoose.Schema({
  tenantId: {
    type: String,
    required: true,
    index: true
  },
  // Immutable once assigned — generated server-side (see
  // JournalService._generateJournalNumber), never caller-supplied.
  journalNumber: {
    type: String,
    required: true,
    immutable: true
  },
  // Config-driven (utils/financeConfig.js) — Manual, Automatic, Recurring,
  // Adjustment, Opening Balance, Closing, Reversal, Exchange Rate
  // Adjustment, Year End Closing.
  journalType: {
    type: String,
    required: true,
    index: true
  },
  // Config-driven — Draft, Pending Approval, Approved, Posted, Rejected,
  // Cancelled, Archived.
  status: {
    type: String,
    required: true,
    index: true
  },
  postingDate: {
    type: Date,
    required: true,
    index: true
  },
  financialYear: {
    type: String,
    required: true,
    index: true
  },
  description: {
    type: String,
    default: null
  },
  referenceNumber: {
    type: String,
    default: null,
    index: true
  },
  currency: {
    type: String,
    required: true
  },
  lines: {
    type: [JournalLineSchema],
    validate: {
      validator: (lines) => Array.isArray(lines) && lines.length >= 2,
      message: "A journal requires at least two lines."
    }
  },
  debitTotal: {
    type: Number,
    required: true
  },
  creditTotal: {
    type: Number,
    required: true
  },
  attachments: [{
    url: { type: String, required: true },
    filename: { type: String, default: null },
    contentType: { type: String, default: null },
    uploadedBy: { type: String, default: null },
    uploadedAt: { type: Date, default: Date.now }
  }],
  remarks: {
    type: String,
    default: null
  },
  // Traceability back to the domain event that generated this journal, for
  // journalType: "Automatic". Null for manually-created journals.
  sourceEvent: {
    eventType: { type: String, default: null },
    eventId: { type: String, default: null }
  },
  // "Original journal always preserved" — a reversal journal points back at
  // the journal it reverses; the original points forward at its reversal.
  reversalOf: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "journal",
    default: null
  },
  reversedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "journal",
    default: null
  },
  isReversed: {
    type: Boolean,
    default: false
  },
  createdBy: { type: String, default: null },
  updatedBy: { type: String, default: null },
  approvedBy: { type: String, default: null },
  approvedAt: { type: Date, default: null },
  rejectedBy: { type: String, default: null },
  rejectedAt: { type: Date, default: null },
  rejectionReason: { type: String, default: null },
  postedBy: { type: String, default: null },
  postedAt: { type: Date, default: null },
  cancelledBy: { type: String, default: null },
  cancelledAt: { type: Date, default: null }
}, { timestamps: true });

JournalSchema.index({ tenantId: 1, journalNumber: 1 }, { unique: true });
JournalSchema.index({ tenantId: 1, status: 1 });
JournalSchema.index({ tenantId: 1, postingDate: 1 });

JournalSchema.set("toJSON", {
  transform: (_, ret) => {
    delete ret.__v;
    return ret;
  }
});

const JournalModel = mongoose.model("journal", JournalSchema);

export default JournalModel;
