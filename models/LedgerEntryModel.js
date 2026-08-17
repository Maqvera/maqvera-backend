import mongoose from "mongoose";

// General Ledger — Finance Module Part 4. "Ledger entries are append-only.
// Updates and deletions are prohibited. Corrections are performed through
// reversing journals." This is enforced here at the schema/DB-access layer
// (pre-hooks throw on every update/delete path), not left as a convention
// callers might accidentally violate — matching the "Immutable Ledger" /
// "Append Only" AI Coding Rules literally.
const LedgerEntrySchema = new mongoose.Schema({
  tenantId: {
    type: String,
    required: true,
    index: true
  },
  journalId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "journal",
    required: true,
    index: true
  },
  journalNumber: {
    type: String,
    required: true
  },
  accountId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "chart_of_account",
    required: true,
    index: true
  },
  accountCode: {
    type: String,
    required: true
  },
  postingDate: {
    type: Date,
    required: true,
    index: true
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
  // Monotonic, atomically-assigned per (tenantId, accountId) — the actual
  // real-time posting order, independent of postingDate (which may be
  // backdated). Running balance is derived from this order, not from
  // postingDate order — see services/LedgerService.js.
  sequence: {
    type: Number,
    required: true
  },
  // "Every ledger entry stores Opening Balance, Debit, Credit, Closing
  // Balance... Allows instant balance retrieval" — the account's running
  // balance immediately BEFORE this entry (= the prior entry's
  // closingBalance/runningBalance, or 0 for the account's first entry).
  // Denormalized here so a plain GET /general-ledger list never needs an
  // extra lookup to show an entry's before/after balance.
  openingBalance: {
    type: Number,
    required: true
  },
  // openingBalance + debit - credit, signed (positive = net debit
  // position) — the account's running/closing balance immediately AFTER
  // this entry. Category-aware Debit/Credit presentation happens at the
  // reporting layer (LedgerService.normalizeBalanceForCategory), not here —
  // this column is a raw, always-correct ledger fact.
  runningBalance: {
    type: Number,
    required: true
  },
  currency: {
    type: String,
    required: true
  },
  referenceNumber: {
    type: String,
    default: null,
    index: true
  },
  description: {
    type: String,
    default: null
  },
  postedBy: {
    type: String,
    default: null
  }
}, { timestamps: true });

LedgerEntrySchema.index({ tenantId: 1, accountId: 1, sequence: 1 }, { unique: true });
LedgerEntrySchema.index({ tenantId: 1, accountId: 1, postingDate: 1 });
LedgerEntrySchema.index({ tenantId: 1, journalId: 1 });

const IMMUTABLE_ERROR = "Ledger entries are immutable and append-only — corrections must be posted as a new (reversing) journal, never by editing or deleting an existing ledger entry.";

const blockMutation = function (next) {
  next(new Error(IMMUTABLE_ERROR));
};

LedgerEntrySchema.pre(["updateOne", "updateMany", "findOneAndUpdate", "deleteOne", "deleteMany", "findOneAndDelete"], { document: false, query: true }, blockMutation);
LedgerEntrySchema.pre("deleteOne", { document: true, query: false }, blockMutation);
LedgerEntrySchema.pre("save", function (next) {
  if (!this.isNew) return next(new Error(IMMUTABLE_ERROR));
  next();
});

LedgerEntrySchema.set("toJSON", {
  transform: (_, ret) => {
    delete ret.__v;
    return ret;
  }
});

const LedgerEntryModel = mongoose.model("ledger_entry", LedgerEntrySchema);

export default LedgerEntryModel;
