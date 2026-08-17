import mongoose from "mongoose";

// Enterprise Identity & Global Resource ID Platform (Improvement 5) — the
// real Resource Registry: what a public `documentNumber`/`globalResourceId`
// actually maps back to internally. This is the direct implementation of
// "Never Expose Internal Database Keys" and the `GET
// /api/v1/numbering/history` endpoint — every number this platform ever
// hands out gets exactly one row here, for the life of the record
// (numbers are never deleted, same "Database delete nahi karna" rule as
// every other CORE platform in this codebase).
//
// `resourceUuid` is deliberately a plain String, not a typed/validated
// ObjectId ref — this registry is genuinely polymorphic (an Invoice, a
// Payment, a Vendor, or a future module none of this platform's code
// knows about), the same "informational, not FK-validated" treatment
// already used for cross-context references elsewhere in this codebase
// (e.g. WalletModel's own doc comment on non-Customer wallet owners).
const GeneratedNumberSchema = new mongoose.Schema({
  tenantId: { type: String, required: true, index: true },
  schemeId: { type: mongoose.Schema.Types.ObjectId, ref: "numbering_scheme", required: true, index: true },
  resourceType: { type: String, required: true, index: true },
  companyId: { type: mongoose.Schema.Types.ObjectId, ref: "org_company", default: null },
  branchId: { type: mongoose.Schema.Types.ObjectId, ref: "org_branch", default: null },
  legalEntityId: { type: mongoose.Schema.Types.ObjectId, ref: "legal_entity", default: null },

  sequenceKey: { type: String, required: true },
  sequenceValue: { type: Number, required: true },
  documentNumber: { type: String, required: true },
  globalResourceId: { type: String, required: true },

  // Set at generateNumber() time when the caller already has it (the
  // common case: creating the number in the same flow as the document),
  // or later via registerResource() when the number must be minted before
  // the real document exists (e.g. to print on a form first).
  resourceUuid: { type: String, default: null, index: true },

  // Config-driven (generatedNumberStatuses) — Reserved, Registered, RolledBack.
  status: { type: String, required: true, index: true },
  registeredAt: { type: Date, default: null },
  registeredBy: { type: String, default: null },
  rolledBackAt: { type: Date, default: null },
  rolledBackBy: { type: String, default: null },
  rolledBackReason: { type: String, default: null },

  generatedBy: { type: String, default: null }
}, { timestamps: true });

GeneratedNumberSchema.index({ tenantId: 1, resourceType: 1, createdAt: -1 });
GeneratedNumberSchema.index({ tenantId: 1, resourceUuid: 1 });

// "Never Allow Duplicate Resource Numbers" — real, but scoped to LIVE
// numbers only. A RolledBack row keeps its historical documentNumber
// string for audit (see rollbackSequence's own doc comment: the sequence
// value itself gets reclaimed by the next generate() call, which then
// produces a NEW row with that same string) — a partial unique index that
// excluded nothing would make gap-aware reuse impossible to ever persist.
// documentNumber is unique per tenant (two tenants legitimately both
// having their own "INV-2027-000001" is expected and fine); globalResourceId
// is unique ACROSS ALL tenants — that is its entire purpose ("Entire ERP
// mein unique").
GeneratedNumberSchema.index({ tenantId: 1, documentNumber: 1 }, { unique: true, partialFilterExpression: { status: { $ne: "RolledBack" } } });
GeneratedNumberSchema.index({ globalResourceId: 1 }, { unique: true, partialFilterExpression: { status: { $ne: "RolledBack" } } });

GeneratedNumberSchema.set("toJSON", {
  transform: (_, ret) => {
    delete ret.__v;
    return ret;
  }
});

const GeneratedNumberModel = mongoose.model("generated_number", GeneratedNumberSchema);

export default GeneratedNumberModel;
