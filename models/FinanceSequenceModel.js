import mongoose from "mongoose";

// Generic atomic per-tenant sequence counter, shared by every Finance
// numbering/ordering need (journal numbers, per-account ledger posting
// order, and future document numbering — Invoice/Receipt/Credit Note in
// later parts) instead of each part inventing its own counter collection.
//
// Correctness matters more here than the countDocuments()-based numbering
// approximation used elsewhere in this codebase (e.g. VisaService.generateCaseNumber):
// a ledger posting sequence race would corrupt running balances, which is
// exactly the kind of "immutable, trustworthy ledger" guarantee this module
// exists to provide. findOneAndUpdate($inc) is atomic per document even on
// a standalone (non-replica-set) MongoDB, so no multi-document transaction
// is required — consistent with the rest of this codebase, which doesn't
// use Mongoose sessions/transactions anywhere.
const FinanceSequenceSchema = new mongoose.Schema({
  tenantId: { type: String, required: true, index: true },
  // e.g. "journalNumber", "ledgerAccountSequence"
  scope: { type: String, required: true },
  // e.g. a financial year ("2027") for journalNumber, or an accountId
  // string for ledgerAccountSequence.
  key: { type: String, required: true },
  seq: { type: Number, required: true, default: 0 }
}, { timestamps: true });

FinanceSequenceSchema.index({ tenantId: 1, scope: 1, key: 1 }, { unique: true });

FinanceSequenceSchema.statics.getNext = async function (tenantId, scope, key) {
  const doc = await this.findOneAndUpdate(
    { tenantId, scope, key },
    { $inc: { seq: 1 } },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
  return doc.seq;
};

const FinanceSequenceModel = mongoose.model("finance_sequence", FinanceSequenceSchema);

export default FinanceSequenceModel;
