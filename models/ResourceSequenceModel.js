import mongoose from "mongoose";

// Enterprise Identity & Global Resource ID Platform (Improvement 5) — the
// atomic counter behind every generated number. Deliberately the exact
// same proven pattern as models/FinanceSequenceModel.js's own doc
// comment (findOneAndUpdate($inc) is atomic per document even on a
// standalone, non-replica-set MongoDB — no multi-document transaction
// required, consistent with the rest of this codebase), reimplemented
// here as its own CORE-platform collection rather than importing Finance's
// model directly — see utils/numberingConfig.js's own doc comment for why.
//
// `key` is only the RESET bucket (the fiscal year string when the owning
// scheme's `includeYear` is true, or the literal "ALL" when it's false) —
// company/branch-specific sequencing doesn't need its own dimension here
// because a company/branch-specific NumberingSchemeModel already gets its
// own distinct `schemeId`, and therefore its own independent counter.
const ResourceSequenceSchema = new mongoose.Schema({
  tenantId: { type: String, required: true, index: true },
  schemeId: { type: mongoose.Schema.Types.ObjectId, ref: "numbering_scheme", required: true, index: true },
  key: { type: String, required: true },
  seq: { type: Number, required: true, default: 0 }
}, { timestamps: true });

ResourceSequenceSchema.index({ tenantId: 1, schemeId: 1, key: 1 }, { unique: true });

ResourceSequenceSchema.statics.getNext = async function (tenantId, schemeId, key) {
  const doc = await this.findOneAndUpdate(
    { tenantId, schemeId, key },
    { $inc: { seq: 1 } },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
  return doc.seq;
};

/**
 * Best-effort compare-and-decrement — only rewinds the counter when it
 * still equals exactly the value that was just issued (`expectedSeq`).
 * If anything else has already claimed a later number in the meantime,
 * this is a real, silent no-op and the just-reserved number is left as a
 * permanent gap — honest "gap-aware, not gapless-guaranteed" behavior,
 * never a fabricated distributed-transaction rollback.
 */
ResourceSequenceSchema.statics.rollbackIfUnclaimed = async function (tenantId, schemeId, key, expectedSeq) {
  const result = await this.findOneAndUpdate(
    { tenantId, schemeId, key, seq: expectedSeq },
    { $inc: { seq: -1 } },
    { new: true }
  );
  return !!result;
};

const ResourceSequenceModel = mongoose.model("resource_sequence", ResourceSequenceSchema);

export default ResourceSequenceModel;
