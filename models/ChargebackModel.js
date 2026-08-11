import mongoose from "mongoose";

// Chargebacks — Finance Module Part 12, grouped under Refund Management per
// the spec's own Business Purpose list ("Chargebacks") and Domain Events
// (ChargebackCreated/ChargebackResolved). Modeled against the original
// PAYMENT, not a Refund we ourselves initiated — a chargeback is a
// bank/card-network-forced event, and PaymentModel's own paymentStatuses
// already lists "Chargeback" as a real status (Part 7) with no endpoint to
// reach it until now. Tenant-scoped only — no branchId (see
// docs/06-external-integrations/03-final-architecture-no-branches-rbac.md).
const ChargebackSchema = new mongoose.Schema({
  tenantId: {
    type: String,
    required: true,
    index: true
  },
  chargebackNumber: {
    type: String,
    required: true,
    immutable: true
  },
  paymentId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "payment",
    required: true,
    index: true
  },
  paymentNumber: { type: String, default: null },
  // Set only when this dispute happens to concern money we ourselves
  // refunded (rare — most chargebacks are filed directly against the
  // original payment, independent of any Refund record).
  refundId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "refund",
    default: null
  },
  amount: {
    type: Number,
    required: true,
    min: 0.01
  },
  currency: {
    type: String,
    required: true
  },
  reason: {
    type: String,
    required: true
  },
  // The card network / gateway's own dispute identifier, when known —
  // caller-supplied, never fabricated (no live dispute-webhook integration
  // exists in this codebase — see docs/05-api/07-finance-api.md Part 12).
  gatewayDisputeId: { type: String, default: null },
  // "Evidence Upload" — reuses this codebase's existing generic document
  // storage abstraction (utils/fileStorage.js / FileUploadService); this
  // model stores the resulting URLs, it does not implement a parallel
  // upload pipeline.
  evidenceUrls: [{ type: String }],
  // Config-driven (chargebackStatuses) — Open, Evidence Submitted, Under
  // Appeal, Won, Lost. "Appeals" (spec bullet) is represented by resubmitting
  // evidence while already "Evidence Submitted" (-> "Under Appeal"), not a
  // separate state machine — see ChargebackService.submitEvidence.
  status: {
    type: String,
    required: true,
    index: true
  },
  resolvedBy: { type: String, default: null },
  resolvedAt: { type: Date, default: null },
  // Mirrors `status` once resolved ("Won" | "Lost") — kept as its own field
  // for a stable, explicit "this is the final outcome" read separate from
  // the still-mutable-until-then `status`.
  finalDecision: { type: String, default: null },
  journalId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "journal",
    default: null
  },
  timeline: [{
    event: { type: String, required: true },
    description: { type: String, default: null },
    performedBy: { type: String, default: null },
    performedAt: { type: Date, default: Date.now }
  }],
  createdBy: { type: String, default: null },
  updatedBy: { type: String, default: null }
}, { timestamps: true });

ChargebackSchema.index({ tenantId: 1, chargebackNumber: 1 }, { unique: true });
ChargebackSchema.index({ tenantId: 1, paymentId: 1 });

ChargebackSchema.set("toJSON", {
  transform: (_, ret) => {
    delete ret.__v;
    return ret;
  }
});

const ChargebackModel = mongoose.model("chargeback", ChargebackSchema);

export default ChargebackModel;
