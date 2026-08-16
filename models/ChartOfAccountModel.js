import mongoose from "mongoose";

// Chart of Accounts — Finance Module Part 2, extended in Part 36 with
// enterprise-readiness cross-cutting fields (Posting Restrictions,
// Financial Dimensions, Multi-Currency/Tax Mapping, Versioning). Tenant is
// the only isolation boundary in this system (see
// docs/06-external-integrations/03-final-architecture-no-branches-rbac.md);
// there is deliberately no branchId here even though the spec doc mentions
// "Branch Isolation"/"Branch Restricted" — see docs/05-api/07-finance-api.md's
// tenant-scope note (Parts 16 and 36). "Merchant"/"Subscription" ownership
// and restrictions have no backing entity anywhere in this codebase and are
// dropped the same way — see Part 36's own reconciliation.
//
// Hierarchy is modeled with parentId (direct edge) + ancestors (materialized
// path of every ancestor's _id, root-to-parent order) so subtree queries and
// cycle detection don't require walking parentId chains at request time.
const ChartOfAccountSchema = new mongoose.Schema({
  tenantId: {
    type: String,
    required: true,
    index: true
  },
  // "Immutable Account Codes" (AI Coding Rule) — enforced here as a schema
  // guarantee (Mongoose refuses writes to an immutable path after the
  // document is no longer new) in addition to the service never accepting
  // accountCode in its update path.
  accountCode: {
    type: String,
    required: true,
    trim: true,
    immutable: true
  },
  name: {
    type: String,
    required: true,
    trim: true
  },
  description: {
    type: String,
    default: null
  },
  // "Alias Search" — real, additional searchable names indexed alongside
  // accountCode/name by SearchEngineService.indexGLAccount.
  aliases: {
    type: [String],
    default: []
  },
  // Category/type/status values are config-driven (utils/financeConfig.js)
  // rather than a hardcoded schema enum, matching this codebase's existing
  // convention for config-driven fields — Joi (middleware/validateRequest.js)
  // is the enforcement point for the current valid-value set.
  category: {
    type: String,
    required: true,
    index: true
  },
  type: {
    type: String,
    required: true,
    index: true
  },
  parentId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "chart_of_account",
    default: null,
    index: true
  },
  ancestors: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: "chart_of_account"
  }],
  level: {
    type: Number,
    default: 0,
    index: true
  },
  status: {
    type: String,
    required: true,
    index: true
  },
  currency: {
    type: String,
    required: true
  },
  allowPosting: {
    type: Boolean,
    default: true
  },
  // "Posting Restrictions" (Part 36) — config-driven (postingRestrictionTypes).
  // Enforced by JournalService._resolveAccountsForLines alongside the
  // pre-existing allowPosting/status/Active checks, not a parallel gate.
  postingRestriction: {
    type: { type: String, default: "Unrestricted" },
    // Used when type === "CurrencyRestricted" — the only currencies a
    // journal line may post to this account in.
    restrictedCurrencies: { type: [String], default: [] },
    // Used when type === "DimensionRestricted" — real per-dimension-type
    // allowed-value lists, e.g. { department: ["<id>"], costCenter: ["CC-1"] }.
    // Keyed by the same lowercase dimension names journal lines use.
    restrictedDimensionValues: { type: mongoose.Schema.Types.Mixed, default: {} }
  },
  // "Financial Dimensions" (Part 36) — which dimension TYPES a posting to
  // this account must/may carry (the VALUES live on the journal line
  // itself — see models/JournalModel.js's own `dimensions` field — this
  // only declares the shape). Config-driven (financialDimensionTypes) for
  // the named catalog; callers may still tag a line with any custom key
  // beyond this list ("Unlimited custom dimensions").
  dimensions: {
    required: { type: [String], default: [] },
    allowed: { type: [String], default: [] }
  },
  // "Account Ownership" (Part 36) — real backing types only: "Company"
  // (the tenant itself — the default and overwhelming majority case) and
  // "GlobalTemplate" (reserved for rows materialized from a
  // ChartTemplateModel blueprint, though templates themselves live in
  // their own tenant-agnostic collection, not as ChartOfAccountModel rows
  // with this ownership type set). Merchant/Branch/SharedFinance dropped —
  // no backing entity exists for any of them in this codebase.
  ownershipType: {
    type: String,
    default: "Company"
  },
  // "Multi-Currency Mapping" (Part 36) — real metadata describing this
  // account's own currency posture; actual conversion/revaluation
  // execution remains Part 19's real CurrencyService (never re-implemented
  // here — see docs/05-api/07-finance-api.md Part 36's own note).
  currencyMapping: {
    allowedTransactionCurrencies: { type: [String], default: [] },
    reportingCurrency: { type: String, default: null },
    revaluationRequired: { type: Boolean, default: false },
    fxGainAccountCode: { type: String, default: null },
    fxLossAccountCode: { type: String, default: null }
  },
  // "Tax Mapping" (Part 36) — taxCode is validated against a real,
  // existing TaxRuleModel row (Part 8/20's own Tax Engine) when supplied;
  // this is a declarative convention for which tax code typically applies
  // to postings on this account, not a second tax-calculation engine.
  taxMapping: {
    taxCode: { type: String, default: null },
    taxType: { type: String, default: null }, // config-driven (taxTypes) — reuses Part 20's own list
    jurisdiction: { type: String, default: null },
    electronicFilingCode: { type: String, default: null }
  },
  // "Budget Integration" (Part 36) — a real flag only; actual budget
  // scoping/enforcement remains the pre-existing ExpenseBudgetModel system
  // (Department/Project/CostCenter scopes), not duplicated per-account.
  budgetControlled: {
    type: Boolean,
    default: false
  },
  // "Deferred Revenue" + "Revenue Recognition Rules" (Part 37) —
  // declarative metadata only; no recognition engine exists in this
  // codebase (see docs/05-api/07-finance-api.md Part 37 for why
  // Subscription/Merchant/Marketplace/Escrow/Wallet/Gift Card/Loyalty
  // account types were declared out of scope). deferredRevenueType tags a
  // Liabilities-category account as a real kind of deferred revenue
  // (config-driven: deferredRevenueAccountTypes) so this ERP's own
  // advance-payment/deposit flows (Invoice type "Deposit", Payment type
  // "Deposit", Booking's deposit_received status) can identify it;
  // recognitionRule is a pure declarative hint for a future recognition
  // scheduler — nothing in this codebase currently reads or acts on it.
  revenueRecognition: {
    deferredRevenueType: { type: String, default: null },
    recognitionRule: {
      method: { type: String, default: null },
      durationMonths: { type: Number, default: null, min: 0 }
    }
  },
  // "Versioning... immutable historical snapshots" (Part 36) — same
  // real revision-history pattern already proven by
  // models/EnterpriseBudgetModel.js (Part 30).
  version: {
    type: Number,
    default: 1
  },
  revisionHistory: [{
    version: { type: Number, required: true },
    changedBy: { type: String, default: null },
    changedAt: { type: Date, default: Date.now },
    changedFields: [{ type: String }],
    snapshot: { type: mongoose.Schema.Types.Mixed, default: {} }
  }],
  // Protected system accounts (Retained Earnings, Sales Revenue, Suspense
  // Account, ...) — never settable through the public create/update payload;
  // only provisioned by trusted server-side seeding/bootstrap code.
  isSystemAccount: {
    type: Boolean,
    default: false,
    index: true
  },
  // Set by the (future, Part 3) Journal/Posting Engine the first time a
  // journal line posts against this account. Drives the "Accounts with
  // journal entries cannot be removed" business rule ahead of the Journal
  // Engine existing — defaults false so accounts remain freely deletable
  // until something has actually posted to them.
  hasPostedTransactions: {
    type: Boolean,
    default: false
  },
  // "AccountMerged" (Part 36) — set on the losing/source account once it
  // has been merged into another; a real, bounded merge (only ever allowed
  // when the source has never posted — see assertCanMerge), never a
  // fabricated reassignment of already-posted journal history.
  mergedInto: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "chart_of_account",
    default: null
  },
  tags: [{
    type: String,
    trim: true
  }],
  createdBy: {
    type: String,
    default: null
  },
  updatedBy: {
    type: String,
    default: null
  }
}, { timestamps: true });

// "Unique Account Code" validation rule — unique per tenant, not globally.
ChartOfAccountSchema.index({ tenantId: 1, accountCode: 1 }, { unique: true });
ChartOfAccountSchema.index({ tenantId: 1, parentId: 1 });
ChartOfAccountSchema.index({ tenantId: 1, category: 1, status: 1 });
ChartOfAccountSchema.index({ tenantId: 1, ancestors: 1 });

ChartOfAccountSchema.set("toJSON", {
  transform: (_, ret) => {
    delete ret.__v;
    return ret;
  }
});

const ChartOfAccountModel = mongoose.model("chart_of_account", ChartOfAccountSchema);

export default ChartOfAccountModel;
