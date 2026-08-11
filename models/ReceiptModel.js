import mongoose from "mongoose";

// Enterprise Receipts — Finance Module Part 8. "Payment != Receipt. A
// payment is a financial transaction. A receipt is an official
// acknowledgment that the payment has been received." Receipts are
// immutable financial evidence linked to a Payment (Part 7) — corrections
// happen via reissue/cancel, never by editing an existing receipt's core
// facts. Tenant-scoped only — no branchId (see
// docs/06-external-integrations/03-final-architecture-no-branches-rbac.md).
const ReceiptSchema = new mongoose.Schema({
  tenantId: {
    type: String,
    required: true,
    index: true
  },
  // Immutable once assigned — generated server-side (FinanceSequenceModel),
  // never caller-supplied.
  receiptNumber: {
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
  paymentNumber: {
    type: String,
    required: true
  },
  // Config-driven (receiptTemplates) — Default, Retail, Corporate,
  // Government, POS, Subscription, Travel, Visa, Custom.
  template: {
    type: String,
    required: true
  },
  // Denormalized from the payment's own partyType/partyId at generation
  // time (or an explicit override at request time) — who the receipt is
  // issued to/for. Optional: a payment can be genuinely partyless (Part 7).
  partyType: {
    type: String,
    enum: ["customer", "vendor"],
    default: null
  },
  partyId: {
    type: mongoose.Schema.Types.ObjectId,
    refPath: "partyType",
    default: null
  },
  amount: {
    type: Number,
    required: true
  },
  currency: {
    type: String,
    required: true
  },
  issueDate: {
    type: Date,
    required: true,
    default: Date.now
  },
  // Config-driven (receiptStatuses) — Draft, Generated, Issued, Delivered,
  // Viewed, Archived, Cancelled, Reissued, Voided.
  status: {
    type: String,
    required: true,
    index: true
  },
  // Snapshot of payment.allocations at generation time — "Immutable
  // Receipts" means what the receipt says was true at issuance stays true
  // even if the underlying payment's allocations change afterward.
  allocationsSnapshot: [{
    targetType: { type: String, required: true },
    targetId: { type: mongoose.Schema.Types.ObjectId, required: true },
    amount: { type: Number, required: true }
  }],
  // "Taxes" / "Discounts" (Response Includes) — structurally present for
  // when the Tax Engine / Discount Engine modules ship (both still
  // unbuilt); functionally empty until then, same pattern as AR/AP's
  // creditNoteIds placeholder.
  taxes: [{ label: String, amount: Number }],
  discounts: [{ label: String, amount: Number }],
  qrCode: {
    // Opaque, cryptographically random, unguessable — the actual access
    // control for the public verification/download endpoints (capability
    // URL pattern), not the receiptId itself.
    token: { type: String, required: true, unique: true, index: true },
    verificationUrl: { type: String, required: true },
    generatedAt: { type: Date, default: Date.now }
  },
  pdf: {
    url: { type: String, default: null },
    storageKey: { type: String, default: null },
    storageProvider: { type: String, default: null },
    generatedAt: { type: Date, default: null }
  },
  // "Digital Signatures: PKI Signature, Organization Seal,
  // Certificate-Based Signing. Optional per organization." Not implemented
  // this pass — no real certificate/PKI infrastructure exists in this
  // codebase to sign with, and a self-generated key would provide no real
  // trust value (see docs/05-api/07-finance-api.md Part 8's Deferred
  // section). Left structurally present, honestly unsigned.
  digitalSignature: {
    isSigned: { type: Boolean, default: false },
    algorithm: { type: String, default: null },
    signedAt: { type: Date, default: null }
  },
  deliveryMethods: [{ type: String }],
  deliveryHistory: [{
    method: { type: String, required: true },
    status: { type: String, enum: ["Pending", "Sent", "Delivered", "Failed", "NotConfigured"], required: true },
    attemptedAt: { type: Date, default: Date.now },
    deliveredAt: { type: Date, default: null },
    failureReason: { type: String, default: null },
    providerResponse: { type: mongoose.Schema.Types.Mixed, default: null }
  }],
  viewCount: { type: Number, default: 0 },
  firstViewedAt: { type: Date, default: null },
  lastViewedAt: { type: Date, default: null },
  downloadCount: { type: Number, default: 0 },
  // "Original receipt preserved" — a reissue creates a NEW receipt
  // document; both ends of the link are recorded, neither is mutated
  // beyond status.
  reissueOf: { type: mongoose.Schema.Types.ObjectId, ref: "receipt", default: null },
  reissuedBy: { type: mongoose.Schema.Types.ObjectId, ref: "receipt", default: null },
  cancelledBy: { type: String, default: null },
  cancelledAt: { type: Date, default: null },
  cancellationReason: { type: String, default: null },
  timeline: [{
    event: { type: String, required: true },
    description: { type: String, default: null },
    performedBy: { type: String, default: null },
    performedAt: { type: Date, default: Date.now }
  }],
  createdBy: { type: String, default: null }
}, { timestamps: true });

ReceiptSchema.index({ tenantId: 1, receiptNumber: 1 }, { unique: true });
ReceiptSchema.index({ tenantId: 1, paymentId: 1 });
ReceiptSchema.index({ tenantId: 1, status: 1 });
ReceiptSchema.index({ tenantId: 1, partyType: 1, partyId: 1 });

ReceiptSchema.set("toJSON", {
  transform: (_, ret) => {
    delete ret.__v;
    return ret;
  }
});

const ReceiptModel = mongoose.model("receipt", ReceiptSchema);

export default ReceiptModel;
