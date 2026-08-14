import mongoose from "mongoose";

// General Journal — Finance Module Part 3. Every financial transaction,
// automatic or manual, passes through here before posting to the
// (immutable) General Ledger. Tenant-scoped only — no branchId (see
// docs/06-external-integrations/03-final-architecture-no-branches-rbac.md).
const JournalLineSchema = new mongoose.Schema({
  accountId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "chart_of_account",
    required: true
  },
  // Snapshot of the account code at posting time — the account name/code
  // can change later (Part 2 allows editing `name`), but a journal line
  // must keep reading the way it did when it was created.
  accountCode: {
    type: String,
    required: true
  },
  // "Journal Header & Journal Line Separation" (File 2, Journal Platform
  // Part 4, item 41) — a real, sequential 1-based position within this
  // journal's own lines array, distinct from Mongo's own subdocument
  // `_id`. Assigned by JournalService, never caller-supplied.
  lineNumber: {
    type: Number,
    default: null
  },
  debit: {
    type: Number,
    default: 0,
    min: 0
  },
  credit: {
    type: Number,
    default: 0,
    min: 0
  },
  // "Multi-Currency Storage" (Part 41, item 44) — the same real, once-
  // computed-at-creation conversion the journal header's own
  // baseCurrencyDebitTotal/baseCurrencyCreditTotal already use (Part 40),
  // now also captured per LINE — real analytical value (a per-account
  // base-currency breakdown), not just a header aggregate. Null when the
  // journal's own currency already IS the tenant's base currency (no
  // conversion ever happened — never a fabricated 1:1 duplicate).
  baseCurrencyDebit: { type: Number, default: null },
  baseCurrencyCredit: { type: Number, default: null },
  // Optional — validated against a real, existing TaxRuleModel row for the
  // tenant when supplied (JournalService), the identical real validation
  // ChartOfAccountModel.taxMapping.taxCode already uses (Part 36); never a
  // fabricated code accepted unchecked.
  taxCode: {
    type: String,
    default: null
  },
  description: {
    type: String,
    default: null
  },
  // "Financial Dimensions" (Part 36) — an open key/value tag set
  // (department/costCenter/project/productLine/region/customer/vendor/
  // employee/asset/taxJurisdiction/businessUnit + any custom key —
  // "Unlimited custom dimensions"). Validated against the target
  // account's own `dimensions.required` by JournalService, not here.
  // Merchant/Store/Warehouse/Product/Campaign/Subscription/Contract
  // (Part 41, item 43's own extended dimension list) were not added to
  // the real, configured catalog — no backing entity for any of them
  // exists anywhere in this codebase; Customer/Vendor/Employee/Asset/
  // CostCenter/Project/BusinessUnit/Department already are real, existing
  // catalog entries (Part 36) and need no further change.
  dimensions: {
    type: mongoose.Schema.Types.Mixed,
    default: {}
  }
}, { _id: true });

const JournalSchema = new mongoose.Schema({
  tenantId: {
    type: String,
    required: true,
    index: true
  },
  // Immutable once assigned — generated server-side (see
  // JournalService._generateJournalNumber), never caller-supplied.
  journalNumber: {
    type: String,
    required: true,
    immutable: true
  },
  // Config-driven (utils/financeConfig.js) — Manual, Automatic, Recurring,
  // Adjustment, Opening Balance, Closing, Reversal, Exchange Rate
  // Adjustment, Year End Closing.
  journalType: {
    type: String,
    required: true,
    index: true
  },
  // Config-driven — Draft, Pending Approval, Approved, Posted, Rejected,
  // Cancelled, Archived.
  status: {
    type: String,
    required: true,
    index: true
  },
  postingDate: {
    type: Date,
    required: true,
    index: true
  },
  financialYear: {
    type: String,
    required: true,
    index: true
  },
  description: {
    type: String,
    default: null
  },
  referenceNumber: {
    type: String,
    default: null,
    index: true
  },
  currency: {
    type: String,
    required: true
  },
  lines: {
    type: [JournalLineSchema],
    validate: {
      validator: (lines) => Array.isArray(lines) && lines.length >= 2,
      message: "A journal requires at least two lines."
    }
  },
  debitTotal: {
    type: Number,
    required: true
  },
  creditTotal: {
    type: Number,
    required: true
  },
  attachments: [{
    url: { type: String, required: true },
    filename: { type: String, default: null },
    contentType: { type: String, default: null },
    // "Journal Attachment Support" (File 2, Journal Platform Part 3, item
    // 36) — a real SHA-256 checksum of the actual uploaded file bytes,
    // computed by POST /journals/:journalId/attachments (multer + crypto —
    // the exact same real pattern ExpenseService.uploadReceipt already
    // uses), never a fabricated value. Attachments added via the plain
    // create/update payload (a caller-supplied URL only, no file bytes to
    // hash) leave this null.
    checksum: { type: String, default: null },
    uploadedBy: { type: String, default: null },
    uploadedAt: { type: Date, default: Date.now }
  }],
  remarks: {
    type: String,
    default: null
  },
  // Traceability back to the domain event that generated this journal, for
  // journalType: "Automatic". Null for manually-created journals.
  sourceEvent: {
    eventType: { type: String, default: null },
    eventId: { type: String, default: null }
  },
  // "Journal Source Types" (File 2, Journal Platform Part 1) — real,
  // optional traceability metadata back to whichever module/entity/record
  // caused this journal to be created. sourceModule is config-driven
  // (financeConfig.journalSourceModules) and validated by JournalService
  // when supplied. correlationId lets multiple journals/events from the
  // same real business operation be traced together (same real pattern
  // already used by utils/eventBus.js/AuditEventModel elsewhere in this
  // codebase).
  sourceModule: {
    type: String,
    default: null,
    index: true
  },
  sourceEntity: {
    type: String,
    default: null
  },
  sourceId: {
    type: String,
    default: null
  },
  sourceVersion: {
    type: Number,
    default: null
  },
  correlationId: {
    type: String,
    default: null,
    index: true
  },
  // "Duplicate Detection" (File 2, Journal Platform Part 2, item 13) — a
  // real, heuristic, flag-not-block check (same "advisory, never a hard
  // stop" discipline as ExpenseService's fraudRiskScore/RefundService's
  // risk score). duplicateSignature is computed at creation from the
  // journal's own accounts/amounts/date/currency; possibleDuplicateOfJournalId
  // is set when a matching signature is found within the configured window.
  duplicateSignature: {
    type: String,
    default: null,
    index: true
  },
  possibleDuplicateOfJournalId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "journal",
    default: null
  },
  // "Correction Journals" (File 2, Journal Platform Part 2, item 21) — the
  // exact same real, immutable-original pattern as reversalOf/reversedBy
  // above, for a correction (a NEW, caller-supplied set of correct entries
  // referencing the original) rather than a reversal (the exact opposite
  // entries). A journal may be corrected at most once, the same one-shot
  // rule reversal already enforces.
  correctionOf: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "journal",
    default: null
  },
  correctedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "journal",
    default: null
  },
  isCorrected: {
    type: Boolean,
    default: false
  },
  // "Batch Journal Processing" (File 2, Journal Platform Part 2, item 14) —
  // set when this journal was created as part of a JournalBatchModel run.
  batchId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "journal_batch",
    default: null,
    index: true
  },
  // "Recurring Journals" (File 2, Journal Platform Part 2, item 19) — set
  // when this journal was generated by the recurring journal scheduler
  // from a RecurringJournalModel definition.
  recurringJournalId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "recurring_journal",
    default: null,
    index: true
  },
  // "Original journal always preserved" — a reversal journal points back at
  // the journal it reverses; the original points forward at its reversal.
  reversalOf: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "journal",
    default: null
  },
  reversedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "journal",
    default: null
  },
  isReversed: {
    type: Boolean,
    default: false
  },
  // "API Response Enhancement" (File 2, Journal Platform Part 3, item 38)
  // — real values captured once at creation from the already-real
  // CurrencyService.getRate call (Part 38/39 already fetched this rate to
  // validate convertibility but discarded it; now it's actually stored).
  // 1/same-currency/null-baseCurrencyAmounts when currency === the
  // tenant's own base currency — no fabricated 1:1 rate is stored for a
  // currency that was never actually converted.
  exchangeRate: { type: Number, default: null },
  baseCurrency: { type: String, default: null },
  baseCurrencyDebitTotal: { type: Number, default: null },
  baseCurrencyCreditTotal: { type: Number, default: null },
  // "Multi-Currency Storage" (Part 41, item 44) — real rate-provenance
  // metadata captured once at creation from the same CurrencyService.getRate
  // call above, so the exact rate used is traceable forever even if the
  // tenant's rate table changes later ("Never recalculate posted journals
  // after exchange rates change" — already true, since exchangeRate itself
  // is never re-derived; this just adds *why*/*which row*). exchangeRateId
  // is null for a triangulated rate (no single ExchangeRateModel row to
  // point at) — never a fabricated reference.
  exchangeRateType: { type: String, default: null },
  exchangeRateDate: { type: Date, default: null },
  exchangeRateId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "exchange_rate",
    default: null
  },
  // File 4 Part 3 — same rate-provenance snapshot, extended with the
  // resolved rate's own provider/version (CurrencyService.getRate already
  // returns both; this just stops discarding them at the journal boundary).
  exchangeRateProvider: { type: String, default: null },
  exchangeRateVersion: { type: Number, default: null },
  // "Accounting Period Reference" (Part 41, item 45) — captured once at
  // creation from the real period FinancialPeriodService.assertPeriodOpen
  // already resolves (previously computed and discarded). A stored,
  // immutable reference to the period actually in force at posting time —
  // more historically accurate than re-deriving "the period covering this
  // date" live on every read, which could theoretically answer differently
  // if periods are ever restructured later. Null when no period is
  // configured for this date (FinancialPeriodService's own "unconfigured =
  // permissive" stance, Part 3/4).
  financialPeriodId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "financial_period",
    default: null
  },
  // "Version Conflict Check" (Part 39/40, item 39) — a real, simple
  // optimistic-concurrency counter (not a fabricated queue-dependent
  // status). Increments on every real change accepted by updateJournal;
  // an `expectedVersion` supplied on a PATCH that no longer matches is
  // rejected rather than silently overwriting a concurrent edit.
  version: { type: Number, default: 1 },
  // "Approval Workflow Integration" (Part 40, item 37) — real, when a
  // matching ApprovalWorkflowDefinitionModel exists for module "Journal"
  // (Part 22's own real platform, the same one Part 35 already proved
  // integrating with Expense). Null when no definition matches — Journal's
  // own local status field remains the authoritative gate either way, the
  // same documented compromise Part 35 already established.
  approvalRequestId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "approval_request",
    default: null
  },
  createdBy: { type: String, default: null },
  updatedBy: { type: String, default: null },
  approvedBy: { type: String, default: null },
  approvedAt: { type: Date, default: null },
  rejectedBy: { type: String, default: null },
  rejectedAt: { type: Date, default: null },
  rejectionReason: { type: String, default: null },
  postedBy: { type: String, default: null },
  postedAt: { type: Date, default: null },
  cancelledBy: { type: String, default: null },
  cancelledAt: { type: Date, default: null },
  // "Archiving Strategy" (Part 41, item 50) — "Archived" already existed as
  // a real, configured status value (financeConfig.journalStatuses) with
  // no reachable endpoint until now, the same kind of pre-existing gap
  // Part 36 found and closed for Chart of Accounts. Posted -> Archived ->
  // restorable back to Posted (archiveJournal/restoreJournal); a real,
  // reversible status transition, not a delete. "Cold Storage" (moving
  // archived data to a separate, cheaper storage tier) was not built — no
  // tiered-storage infrastructure exists for any collection in this
  // codebase; see docs/05-api/07-finance-api.md Part 41.
  archivedBy: { type: String, default: null },
  archivedAt: { type: Date, default: null },
  restoredBy: { type: String, default: null },
  restoredAt: { type: Date, default: null }
}, { timestamps: true });

JournalSchema.index({ tenantId: 1, journalNumber: 1 }, { unique: true });
JournalSchema.index({ tenantId: 1, status: 1 });
JournalSchema.index({ tenantId: 1, postingDate: 1 });
// "Optimized Indexes" (Part 41, item 51) — the real, MongoDB-native subset:
// a multikey index on the embedded lines' own accountId (real "which
// journals touched this account" queries), sourceEvent.eventId (event
// traceability), and a tenant+period composite (real "all journals in this
// accounting period" queries, the Company+Period pairing the spec asks
// for — Company is tenantId in this architecture). Customer/Vendor/
// Merchant/Subscription-ID indexes were not added — Customer/Vendor live
// inside the open-ended `lines.dimensions` Mixed map, which MongoDB
// cannot usefully index without restructuring it into typed fields (a
// larger schema change with no concrete query pattern driving it yet);
// Merchant/Subscription have no backing field to index at all.
JournalSchema.index({ tenantId: 1, "lines.accountId": 1 });
JournalSchema.index({ tenantId: 1, "lines.accountId": 1, postingDate: 1 });
JournalSchema.index({ tenantId: 1, "sourceEvent.eventId": 1 });
JournalSchema.index({ tenantId: 1, financialPeriodId: 1 });

JournalSchema.set("toJSON", {
  transform: (_, ret) => {
    delete ret.__v;
    return ret;
  }
});

const JournalModel = mongoose.model("journal", JournalSchema);

export default JournalModel;
