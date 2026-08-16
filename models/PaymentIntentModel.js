import mongoose from "mongoose";

// Enterprise Customer Payments — Finance Module Part 18 Part 2 (API
// Contracts Refactoring). "POST /api/v1/customer-payments... does not
// immediately collect money. It creates a secure payment transaction that
// can later be completed using any supported payment provider." This is
// that pre-money-movement record — the front door `POST /customer-payments`
// creates today, independent of whether the underlying collection strategy
// is invoice-based (CustomerCollectionModel, Part 18) or one of the newly
// generic collection sources this Part introduces. It never moves money
// itself: Part 3 of this refactor is what will actually authorize/capture
// against it and produce a real PaymentModel row (Part 7's own Enterprise
// Payment Engine) — `paymentId` below stays null until then.
//
// Tenant-scoped only — no branchId (see
// docs/06-external-integrations/03-final-architecture-no-branches-rbac.md).
// The spec's own "Validate Company"/"Validate Branch"/`X-Company-ID`/
// `X-Branch-ID` are dropped per the standing master instructions; tenant
// identity always comes from `getAccessScope(req)` (the verified JWT),
// never a client-supplied header — the spec's own `X-Tenant-ID` header is
// likewise never read for isolation purposes.
//
// `merchantId`/`storeId`/`subscriptionId` are optional/informational only
// — no Merchant/Store/Subscription module exists anywhere in this codebase
// yet to validate "Merchant Exists"/"Subscription Active" against, so
// these are recorded honestly (same "structurally present, functionally
// informational until that module ships" treatment this codebase already
// gives `AccountsReceivableModel.invoiceId` before Part 9's Invoice module
// existed, and `creditNoteIds`/`debitNoteIds`) rather than faking a
// validation that always passes.
const PaymentIntentSchema = new mongoose.Schema({
  tenantId: {
    type: String,
    required: true,
    index: true
  },
  // Immutable once assigned — generated server-side, never caller-supplied
  // (same convention as Payment/Journal/CustomerCollection numbering).
  paymentReference: {
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
  // Denormalized snapshot — Customer is not Finance-owned, same convention
  // as AccountsReceivableModel.customerName / CustomerCollectionModel.customerName.
  customerName: {
    type: String,
    required: true
  },
  // Informational only — see doc comment above. Not an ObjectId `ref`
  // because there is no Merchant collection in this codebase to resolve
  // against yet; kept as a generic identifier so this field is ready the
  // moment a Merchant Platform module ships without a schema migration.
  merchantId: { type: mongoose.Schema.Types.Mixed, default: null },
  storeId: { type: mongoose.Schema.Types.Mixed, default: null },
  subscriptionId: { type: mongoose.Schema.Types.Mixed, default: null },
  // Config-driven (utils/financeConfig.js collectionSources).
  collectionSource: {
    type: String,
    required: true,
    index: true
  },
  // Generic pointer into whatever system owns `collectionSource` (an
  // AccountsReceivable id for "Sales Invoice", a caller-supplied id for
  // every other source since no owning module exists yet — see
  // collectionSources' own doc comment in financeConfig.js).
  sourceDocumentId: { type: mongoose.Schema.Types.Mixed, default: null },
  // Set once CustomerCollectionService creates the paired collection/
  // allocation-strategy record (Part 18) this intent is settling —
  // bidirectional with CustomerCollectionModel.paymentIntentId.
  collectionId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "customer_collection",
    default: null,
    index: true
  },
  currency: {
    type: String,
    required: true
  },
  amount: {
    type: Number,
    required: true,
    min: 0.01
  },
  // Config-driven (paymentMethods). Optional — real hosted-checkout flows
  // (Stripe Payment Intents included) routinely create the intent BEFORE
  // the customer has chosen/entered a payment method; when unknown, this
  // stays null until Part 3's execution step resolves it.
  paymentMethod: {
    type: String,
    default: null
  },
  // Config-driven (gateways) — the spec's own "Payment Provider".
  paymentProvider: {
    type: String,
    required: true
  },
  // Config-driven (paymentIntentStatuses) — Created, Pending, Waiting
  // Customer, Authorized, Captured, Cancelled, Expired, Failed, Refunded,
  // Disputed, Chargeback.
  status: {
    type: String,
    required: true,
    index: true
  },
  // Set once Part 3's execution endpoint actually moves money through
  // Part 7's own PaymentModel.
  paymentId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "payment",
    default: null
  },
  // Only ever populated by a real gateway adapter call
  // (services/gateways/*.createSession) — never fabricated when the
  // selected provider has no session concept (Manual) or isn't configured.
  gatewaySession: {
    sessionId: { type: String, default: null },
    url: { type: String, default: null },
    clientSecret: { type: String, default: null },
    rawResponse: { type: mongoose.Schema.Types.Mixed, default: null }
  },
  expiresAt: {
    type: Date,
    default: null,
    index: true
  },
  paymentDate: { type: Date, default: null },
  returnUrl: { type: String, default: null },
  cancelUrl: { type: String, default: null },
  metadata: { type: mongoose.Schema.Types.Mixed, default: null },
  // "Strong Customer Authentication... 3D Secure 2, OTP, Bank
  // Authentication, Biometric Authentication, Risk-Based Authentication"
  // (Part 18 Part 3). No real 3DS/SCA integration exists in this
  // codebase (no provider credentials for one) — these are recorded
  // honestly as real fraud-signal input/audit context, never used to
  // fabricate a fake authentication challenge/response.
  authenticationMetadata: {
    customerIp: { type: String, default: null },
    deviceId: { type: String, default: null },
    riskSessionId: { type: String, default: null },
    savePaymentMethod: { type: Boolean, default: false }
  },
  // "Correlation-ID... Supports safe retries." Distinct from the
  // per-request `X-Request-ID`/`req.requestId` (middleware/requestContext.js)
  // — a Correlation-ID is caller-supplied and meant to trace one logical
  // payment attempt across multiple HTTP requests/retries/webhooks, so it
  // is persisted here rather than only echoed on one response.
  correlationId: { type: String, default: null, index: true },
  failureReason: { type: String, default: null },
  timeline: [{
    event: { type: String, required: true },
    description: { type: String, default: null },
    performedBy: { type: String, default: null },
    performedAt: { type: Date, default: Date.now }
  }],
  createdBy: { type: String, default: null }
}, { timestamps: true });

PaymentIntentSchema.index({ tenantId: 1, paymentReference: 1 }, { unique: true });
PaymentIntentSchema.index({ tenantId: 1, status: 1 });
PaymentIntentSchema.index({ tenantId: 1, customerId: 1, status: 1 });

PaymentIntentSchema.set("toJSON", {
  transform: (_, ret) => {
    delete ret.__v;
    return ret;
  }
});

const PaymentIntentModel = mongoose.model("payment_intent", PaymentIntentSchema);

export default PaymentIntentModel;
