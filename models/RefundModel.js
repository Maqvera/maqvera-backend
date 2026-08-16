import mongoose from "mongoose";
const RefundSchema = new mongoose.Schema({
  tenantId: {
    type: String,
    required: true,
    index: true
  },
  refundNumber: {
    type: String,
    required: true,
    immutable: true
  },
  paymentId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "payment",
    default: null,
    index: true
  },
  paymentNumber: { type: String, default: null },
  creditNoteId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "credit_note",
    default: null,
    index: true
  },
  // Cache of the CustomerCredit redeemed at processing time (creditNote-linked
  // path only) — same "cache of a live join, not the authority" discipline as
  // CreditNoteModel.arReceivableId.
  customerCreditId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "customer_credit",
    default: null
  },
  invoiceId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "invoice",
    default: null
  },
  // Optional/informational — which of this tenant's Bank Accounts (Part 13)
  // this refund pays out from. When set, BankAccountService's own event
  // listener posts a real BankTransactionModel debit the moment this
  // refund reaches "Completed".
  bankAccountId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "bank_account",
    default: null
  },
  // Optional/informational, resolved from payment.partyId (direct path) or
  // creditNote.customerId (linked path) — same "known when known" stance as
  // PaymentModel.partyId.
  customerId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "customer",
    default: null,
    index: true
  },
  customerName: { type: String, default: null },
  refundAmount: {
    type: Number,
    required: true,
    min: 0.01
  },
  currency: {
    type: String,
    required: true
  },
  // Config-driven (refundMethods) — Original Gateway, Bank Transfer, Cash,
  // Cheque, Customer Wallet, Store Credit, Custom Method.
  refundMethod: {
    type: String,
    required: true
  },
  // Only populated when refundMethod === "Original Gateway" — the gateway
  // that processed the original payment (Manual/Stripe/...).
  gateway: { type: String, default: null },
  reason: {
    type: String,
    required: true
  },
  // Config-driven (refundStatuses) — Requested, Under Review, Approved,
  // Processing, Completed, Rejected, Cancelled, Failed. Deliberately no
  // "Chargeback" value here — see utils/financeConfig.js chargebackStatuses
  // doc comment for why that's modeled against Payment/ChargebackModel
  // instead.
  status: {
    type: String,
    required: true,
    index: true
  },
  // "Refund Eligibility... Checks: Payment Status, Credit Note, Business
  // Rules, Time Window" — the real, deterministic (non-advisory) rules
  // RefundService.computeRefundEligibility evaluated at creation.
  eligibility: {
    withinTimeWindow: { type: Boolean, default: true },
    remainingRefundableAmount: { type: Number, default: null },
    checkedAt: { type: Date, default: null }
  },
  // "Fraud Risk... AI advisory only" — rule-based (not AI), never blocks
  // creation, purely informs the approver. Same shape/spirit as
  // PaymentModel.fraudCheck.
  riskCheck: {
    riskScore: { type: Number, default: 0 },
    flags: [{ type: String }],
    checkedAt: { type: Date, default: null }
  },
  gatewayDetails: {
    transactionId: { type: String, default: null },
    rawResponse: { type: mongoose.Schema.Types.Mixed, default: null }
  },
  journalId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "journal",
    default: null
  },
  pdf: {
    url: { type: String, default: null },
    storageKey: { type: String, default: null },
    storageProvider: { type: String, default: null },
    generatedAt: { type: Date, default: null }
  },
  approvedBy: { type: String, default: null },
  approvedAt: { type: Date, default: null },
  rejectedBy: { type: String, default: null },
  rejectedAt: { type: Date, default: null },
  rejectionReason: { type: String, default: null },
  processedAt: { type: Date, default: null },
  completedAt: { type: Date, default: null },
  failureReason: { type: String, default: null },
  cancelledBy: { type: String, default: null },
  cancelledAt: { type: Date, default: null },
  cancellationReason: { type: String, default: null },
  timeline: [{
    event: { type: String, required: true },
    description: { type: String, default: null },
    performedBy: { type: String, default: null },
    performedAt: { type: Date, default: Date.now }
  }],
  createdBy: { type: String, default: null },
  updatedBy: { type: String, default: null }
}, { timestamps: true });

RefundSchema.index({ tenantId: 1, refundNumber: 1 }, { unique: true });
RefundSchema.index({ tenantId: 1, paymentId: 1, status: 1 });
RefundSchema.index({ tenantId: 1, customerId: 1, status: 1 });

RefundSchema.set("toJSON", {
  transform: (_, ret) => {
    delete ret.__v;
    return ret;
  }
});

const RefundModel = mongoose.model("refund", RefundSchema);

export default RefundModel;
