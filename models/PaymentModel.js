import mongoose from "mongoose";

// Enterprise Payment Engine — Finance Module Part 7. Consolidates what was
// previously two parallel minimal models: Part 5's customer-side
// PaymentModel and Part 6's vendor-side VendorPaymentModel (now deleted).
// Per the spec's own "Principal Software Architect Review": AR and AP are
// "specialized workflows built on top of the same Enterprise Payment
// Engine" — the payment record represents the movement of money; AR/AP/
// future modules determine why it exists. Tenant-scoped only — no
// branchId (see docs/06-external-integrations/03-final-architecture-no-branches-rbac.md).
//
// Deliberately independent of any party at creation — the spec's own
// request example has no customer/vendor reference at all ("Payments are
// independent financial transactions that may later be allocated..."). A
// party is optional/informational (partyType/partyId); the real
// relationship is established through `allocations[]`.
const PaymentAllocationSchema = new mongoose.Schema({
  // Config-driven (utils/financeConfig.js allocationTargetTypes).
  targetType: { type: String, required: true },
  // No `ref` here on purpose — targetType spans several different
  // collections (chart_of_account's siblings accounts_receivable/
  // accounts_payable, plus booking/visa_case/travel_plan), and Mongoose
  // populate would need a matching refPath field per target collection
  // name. Callers resolve targetId themselves via targetType, same as this
  // module already does internally in PaymentService.allocate.
  targetId: { type: mongoose.Schema.Types.ObjectId, required: true },
  amount: { type: Number, required: true },
  allocatedAt: { type: Date, default: Date.now },
  allocatedBy: { type: String, default: null }
}, { _id: true });

const PaymentSchema = new mongoose.Schema({
  tenantId: {
    type: String,
    required: true,
    index: true
  },
  // Immutable once assigned — generated server-side, never caller-supplied
  // (same convention as Journal numbering).
  paymentNumber: {
    type: String,
    required: true,
    immutable: true
  },
  // Config-driven (paymentTypes) — Customer, Vendor, Employee, Refund,
  // Advance, Deposit. The spec's own request example field.
  paymentType: {
    type: String,
    required: true,
    index: true
  },
  // Optional/informational — who the money is to/from, when known upfront.
  // Not required, not validated against allocations (a payment could in
  // principle split across multiple different parties' receivables).
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
  // Optional/informational, same "known when known" stance as partyId —
  // which of this tenant's Bank Accounts (Part 13) this payment settles
  // into/from. When set, BankAccountService's own event listener posts a
  // real BankTransactionModel entry and moves that account's balance the
  // moment this payment is Captured.
  bankAccountId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "bank_account",
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
  // Config-driven (paymentMethods) — Cash, Bank Transfer, Cheque, Credit
  // Card, Debit Card, Wallet, UPI, Mobile Money, Crypto, Custom Method.
  paymentMethod: {
    type: String,
    required: true
  },
  // Config-driven (gateways) — Manual (Cash/Cheque/Bank Transfer settle
  // without an external call), Stripe (real, wired), or a configured-but-
  // not-yet-implemented value (PayPal/Square/AuthorizeNet/Adyen/Razorpay/Custom).
  gateway: {
    type: String,
    required: true
  },
  // Config-driven (paymentStatuses) — full lifecycle, see
  // utils/financeConfig.js doc comment.
  status: {
    type: String,
    required: true,
    index: true
  },
  reference: {
    type: String,
    default: null,
    index: true
  },
  transactionDate: {
    type: Date,
    required: true,
    default: Date.now
  },
  // Decrements as `allocate` consumes it against one or more targets.
  // Overpayment beyond a receivable/payable's balance becomes Customer/
  // Vendor Credit (Parts 5/6) rather than sitting here unresolved.
  unallocatedAmount: {
    type: Number,
    required: true
  },
  allocations: [PaymentAllocationSchema],
  // Only ever populated by a real gateway adapter call (services/gateways/) —
  // never fabricated for a Manual-gateway payment.
  gatewayDetails: {
    transactionId: { type: String, default: null },
    authorizedAt: { type: Date, default: null },
    capturedAt: { type: Date, default: null },
    rawResponse: { type: mongoose.Schema.Types.Mixed, default: null }
  },
  failureReason: {
    type: String,
    default: null
  },
  // Rule-based (not AI) fraud signal — see utils/financeConfig.js doc
  // comment and PaymentService.computeFraudSignals.
  fraudCheck: {
    riskScore: { type: Number, default: 0 },
    flags: [{ type: String }],
    checkedAt: { type: Date, default: null }
  },
  // "Complete history preserved" — a void/refund never deletes or mutates
  // history, only adds a linked record + status change (mirrors Journal's
  // reversal pattern).
  reversalOf: { type: mongoose.Schema.Types.ObjectId, ref: "payment", default: null },
  reversedBy: { type: mongoose.Schema.Types.ObjectId, ref: "payment", default: null },
  voidedAt: { type: Date, default: null },
  voidedBy: { type: String, default: null },
  refundedAmount: { type: Number, default: 0 },
  timeline: [{
    event: { type: String, required: true },
    description: { type: String, default: null },
    performedBy: { type: String, default: null },
    performedAt: { type: Date, default: Date.now }
  }],
  createdBy: {
    type: String,
    default: null
  }
}, { timestamps: true });

PaymentSchema.index({ tenantId: 1, paymentNumber: 1 }, { unique: true });
PaymentSchema.index({ tenantId: 1, status: 1 });
PaymentSchema.index({ tenantId: 1, partyType: 1, partyId: 1 });
PaymentSchema.index({ tenantId: 1, reference: 1 });

PaymentSchema.set("toJSON", {
  transform: (_, ret) => {
    delete ret.__v;
    return ret;
  }
});

const PaymentModel = mongoose.model("payment", PaymentSchema);

export default PaymentModel;
