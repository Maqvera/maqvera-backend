import mongoose from "mongoose";

// Enterprise Customer Payments — Finance Module Part 18. "The Customer
// Collection Platform manages the collection strategy. The Payment Engine
// performs the actual payment." This model is the real collection/decision
// record — which customer, which invoices, when reminders go out, whether
// installments apply — it never stores money-movement logic itself, only
// what to collect, from whom, and how; the actual movement always happens
// through Part 7's own PaymentModel (`installments[].paymentId`/
// `payments[].paymentId` below) and Part 5's own AccountsReceivableModel
// allocations. Tenant-scoped only — no branchId (see
// docs/06-external-integrations/03-final-architecture-no-branches-rbac.md;
// the spec's own "Branch Match"/"Branch Isolation" language is dropped per
// the standing master instructions — see docs/05-api/07-finance-api.md
// Part 18). The mirror-opposite of Part 17's VendorPaymentModel on the AR
// side.
const CollectionLineItemSchema = new mongoose.Schema({
  // Optional as of Part 18 Part 2 — "Customer Payment is NOT Invoice."
  // Only populated for the "Sales Invoice" collectionSource, where a real
  // AccountsReceivableModel record exists to reference; every other
  // collectionSource (Subscription Invoice, Marketplace Order, Deposit,
  // Wallet Recharge, ...) has no AR record backing it, so this stays null
  // and `invoiceNumber` carries the caller-supplied/generated reference
  // instead.
  receivableId: { type: mongoose.Schema.Types.ObjectId, ref: "accounts_receivable", default: null },
  invoiceNumber: { type: String, required: true },
  amount: { type: Number, required: true, min: 0.01 },
  // Tracked per-line so "Partial Payments" can apply a collected amount
  // across multiple invoices proportionally/FIFO without re-deriving it
  // from the payments[] history on every read.
  collectedAmount: { type: Number, default: 0 }
}, { _id: false });

const InstallmentSchema = new mongoose.Schema({
  installmentNumber: { type: Number, required: true },
  dueDate: { type: Date, required: true },
  amount: { type: Number, required: true, min: 0.01 },
  paidAmount: { type: Number, default: 0 },
  // Draft | Pending | Paid | Overdue | Cancelled — a small, fixed, real
  // state set for the embedded schedule line, distinct from the parent
  // collection's own config-driven `status`.
  status: { type: String, default: "Pending" },
  paymentId: { type: mongoose.Schema.Types.ObjectId, ref: "payment", default: null },
  paidAt: { type: Date, default: null }
}, { _id: false });

// A single collection may collect payment across multiple calls (partial
// payments) — each real Payment Engine capture this collection has gone
// through is recorded here, distinct from an installment's own paymentId
// (an installment plan payment always lands here too).
const CollectionPaymentSchema = new mongoose.Schema({
  paymentId: { type: mongoose.Schema.Types.ObjectId, ref: "payment", required: true },
  amount: { type: Number, required: true },
  collectedAt: { type: Date, default: Date.now },
  installmentNumber: { type: Number, default: null }
}, { _id: false });

// File 6 Part 5 — "POST/GET .../attachments." Same real
// checksum+storeDocumentPdf pattern as ExpenseModel's own
// ExpenseAttachmentSchema, without that schema's Expense-specific
// OCR/fraud-scoring fields (there is no claimed amount or category cap to
// reconcile a collection attachment against).
const CollectionAttachmentSchema = new mongoose.Schema({
  filename: { type: String, required: true },
  url: { type: String, default: null },
  storageKey: { type: String, default: null },
  storageProvider: { type: String, default: null },
  mimeType: { type: String, default: null },
  fileSize: { type: Number, default: null },
  checksum: { type: String, default: null },
  uploadedBy: { type: String, default: null },
  uploadedAt: { type: Date, default: Date.now }
});

// "POST/GET .../comments" — free-text staff notes on the collection,
// distinct from `timeline` (system-observed lifecycle events, still
// writable via its own POST .../timeline for a manual log line).
const CollectionCommentSchema = new mongoose.Schema({
  text: { type: String, required: true },
  createdBy: { type: String, default: null },
  createdAt: { type: Date, default: Date.now }
});

const CustomerCollectionSchema = new mongoose.Schema({
  tenantId: {
    type: String,
    required: true,
    index: true
  },
  collectionNumber: {
    type: String,
    required: true,
    immutable: true
  },
  customerId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "customer",
    required: true,
    index: true
  },
  // Denormalized snapshot — Customer is not Finance-owned (Part 1), same
  // convention as AccountsReceivableModel.customerName.
  customerName: { type: String, required: true },
  // "Merchant Awareness"/"Subscription Awareness" — Part 18 Part 2.
  // Informational only (see PaymentIntentModel's own doc comment for why
  // no ObjectId `ref`/existence validation exists yet).
  merchantId: { type: mongoose.Schema.Types.Mixed, default: null },
  storeId: { type: mongoose.Schema.Types.Mixed, default: null },
  subscriptionId: { type: mongoose.Schema.Types.Mixed, default: null },
  // Config-driven (utils/financeConfig.js collectionSources). Defaults to
  // "Sales Invoice" for every collection created before this Part existed
  // and every legacy `invoiceIds`-shaped request today — a real value, not
  // a nullable afterthought, since it is now the field this collection's
  // whole line-item strategy is decided from.
  collectionSource: { type: String, required: true, index: true },
  sourceDocumentId: { type: mongoose.Schema.Types.Mixed, default: null },
  // Bidirectional with PaymentIntentModel.collectionId — the front-door
  // Payment Intent `POST /customer-payments` now creates alongside this
  // record.
  paymentIntentId: { type: mongoose.Schema.Types.ObjectId, ref: "payment_intent", default: null },
  correlationId: { type: String, default: null },
  // Part 18 Part 3 — set when a Manual/Authorize Only/Delayed/Partial
  // Capture mode leaves a payment sitting in "Authorized" status (status
  // "Payment Authorized" above); cleared once captured. The Payment
  // Engine's own real record of that reservation — never a second
  // authorization concept invented here.
  authorizedPaymentId: { type: mongoose.Schema.Types.ObjectId, ref: "payment", default: null },
  lineItems: {
    type: [CollectionLineItemSchema],
    validate: {
      validator: (lines) => Array.isArray(lines) && lines.length >= 1,
      message: "A collection request requires at least one outstanding invoice."
    }
  },
  totalAmount: { type: Number, required: true },
  collectedAmount: { type: Number, default: 0 },
  currency: { type: String, required: true },
  paymentDueDate: { type: Date, required: true, index: true },
  preferredMethod: { type: String, default: null },
  // Config-driven (customerCollectionStatuses) — Requested, Partially
  // Collected, Collected, Overdue, Payment Failed, Disputed, Written Off,
  // Cancelled, Closed. "Payment Requested"/"Reminder Sent" from the spec's
  // Lifecycle diagram collapse into "Requested" — see
  // utils/financeConfig.js's own doc comment.
  status: {
    type: String,
    required: true,
    index: true
  },
  // Reuses AR's own collectionStages (Part 5) — same escalation ladder the
  // whole ERP already walks, not a second parallel list.
  collectionStage: { type: String, default: null },
  isInstallmentPlan: { type: Boolean, default: false },
  installmentFrequency: { type: String, default: null },
  // Part 18 Part 4 — "Down Payment + Installments," "Balloon Payment,"
  // "Grace Period." Real amounts/values actually used when building the
  // schedule (CustomerCollectionService.computeInstallmentSchedule),
  // recorded here for the life of the plan rather than only living in the
  // request that created it.
  downPaymentAmount: { type: Number, default: 0 },
  balloonAmount: { type: Number, default: 0 },
  installmentGracePeriodDays: { type: Number, default: null },
  installments: { type: [InstallmentSchema], default: [] },
  payments: { type: [CollectionPaymentSchema], default: [] },
  paymentLink: {
    token: { type: String, default: null },
    url: { type: String, default: null },
    qrCodeUrl: { type: String, default: null },
    generatedAt: { type: Date, default: null },
    expiresAt: { type: Date, default: null },
    viewCount: { type: Number, default: 0 }
  },
  lateFee: {
    applied: { type: Boolean, default: false },
    amount: { type: Number, default: 0 },
    appliedAt: { type: Date, default: null }
  },
  disputeReason: { type: String, default: null },
  disputedBy: { type: String, default: null },
  disputedAt: { type: Date, default: null },
  writeOff: {
    isWrittenOff: { type: Boolean, default: false },
    reason: { type: String, default: null },
    approvedBy: { type: String, default: null },
    approvedAt: { type: Date, default: null }
  },
  cancellationReason: { type: String, default: null },
  cancelledBy: { type: String, default: null },
  cancelledAt: { type: Date, default: null },
  requestedBy: { type: String, default: null },
  requestedAt: { type: Date, default: null },
  collectedAt: { type: Date, default: null },
  closedBy: { type: String, default: null },
  closedAt: { type: Date, default: null },
  // "POST .../reopen" — the mirror of closedBy/closedAt above.
  reopenedBy: { type: String, default: null },
  reopenedAt: { type: Date, default: null },
  reopenReason: { type: String, default: null },
  attachments: { type: [CollectionAttachmentSchema], default: [] },
  comments: { type: [CollectionCommentSchema], default: [] },
  timeline: [{
    event: { type: String, required: true },
    description: { type: String, default: null },
    performedBy: { type: String, default: null },
    performedAt: { type: Date, default: Date.now }
  }],
  createdBy: { type: String, default: null },
  updatedBy: { type: String, default: null }
}, {
  timestamps: true,
  // "Collections support optimistic locking" (AI Coding Rule) — every
  // service method that mutates this model follows the same
  // findOne-then-mutate-then-.save() shape (never findOneAndUpdate), so
  // Mongoose's own real optimistic-concurrency check (VersionError on a
  // stale .save()) is a correct, working guarantee here, not a fabricated
  // one bolted onto a findOneAndUpdate-based write path.
  optimisticConcurrency: true
});

CustomerCollectionSchema.index({ tenantId: 1, collectionNumber: 1 }, { unique: true });
CustomerCollectionSchema.index({ tenantId: 1, customerId: 1, status: 1 });
CustomerCollectionSchema.index({ tenantId: 1, status: 1, paymentDueDate: 1 });
CustomerCollectionSchema.index({ tenantId: 1, collectionSource: 1 });
CustomerCollectionSchema.index({ tenantId: 1, merchantId: 1 });
CustomerCollectionSchema.index({ tenantId: 1, subscriptionId: 1 });
CustomerCollectionSchema.index({ "paymentLink.token": 1 });

CustomerCollectionSchema.set("toJSON", {
  transform: (_, ret) => {
    delete ret.__v;
    return ret;
  }
});

const CustomerCollectionModel = mongoose.model("customer_collection", CustomerCollectionSchema);

export default CustomerCollectionModel;
