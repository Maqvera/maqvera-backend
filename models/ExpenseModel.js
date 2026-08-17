import mongoose from "mongoose";

// Enterprise Expense Management — Finance Module Part 16, refactored in
// Parts 34-35. "The expense is not the payment. The reimbursement is the
// financial event." Tenant-scoped only — no isolation-relevant branchId
// (see docs/06-external-integrations/03-final-architecture-no-branches-rbac.md).
// The "Merchant/Subscription/Legal Entity/Business Unit/Branch" hierarchy
// from the refactor spec maps onto this codebase's real architecture:
// Legal Entity IS tenantId (no separate model), Merchant/Subscription are
// out of scope (no billing/marketplace infrastructure exists), and
// businessUnit/branch below are purely descriptive organizational labels —
// never used to scope or restrict data access, exactly like
// department/costCenter/projectId already are.
const ExpenseAttachmentSchema = new mongoose.Schema({
  filename: { type: String, required: true },
  url: { type: String, default: null },
  storageKey: { type: String, default: null },
  storageProvider: { type: String, default: null },
  mimeType: { type: String, default: null },
  // "Every attachment contains... File Size" — real, from `file.buffer.length`
  // at upload time (multer memoryStorage already gives this for free).
  fileSize: { type: Number, default: null },
  // SHA-256 of the raw file — "Duplicate Detection" runs against this,
  // real and deterministic, not a fuzzy OCR-based guess.
  checksum: { type: String, default: null },
  // "Virus Scan Status" — same honest pattern already established by
  // `models/EnterpriseDocumentModel.js`'s own `virusScanStatus` (Part
  // 9/document verification): "skipped" is the real status every upload
  // gets (no scanner is configured anywhere in this codebase); "clean" is
  // never falsely claimed for a scan that didn't happen.
  virusScanStatus: { type: String, enum: ["clean", "infected", "pending", "skipped"], default: "skipped" },
  // "Encryption Status" — a real, honest property of the actual storage
  // backend the file landed on (`storageProvider`), not app-level file
  // encryption (no such capability exists anywhere in this codebase —
  // `utils/fieldEncryption.js` only ever encrypts short structured string
  // fields like bank account numbers, never binary file content).
  // Cloudinary/S3 both provide real server-side encryption-at-rest;
  // the `local` backend does not.
  encryptionStatus: { type: String, enum: ["AtRestServerSide", "None"], default: "None" },
  ocr: {
    status: { type: String, enum: ["Pending", "Completed", "Failed", "Skipped"], default: "Pending" },
    extractedText: { type: String, default: null },
    extractedAmount: { type: Number, default: null },
    // "Invoice Date"/"Receipt Date" from the spec collapse into this one
    // real field — a single receipt image gives no reliable way to
    // distinguish the two dates (most receipts only print one date at
    // all); an honest documented collapse, not two independently
    // extracted values.
    extractedDate: { type: Date, default: null },
    extractedVendor: { type: String, default: null },
    extractedReceiptNumber: { type: String, default: null },
    confidence: { type: Number, default: null },
    processedAt: { type: Date, default: null },
    // "Manual Corrections" — a human-supplied override of an OCR
    // misread, kept alongside (never overwriting) the original
    // machine-extracted values above, so both remain visible.
    manualCorrection: {
      amount: { type: Number, default: null },
      vendor: { type: String, default: null },
      date: { type: Date, default: null },
      receiptNumber: { type: String, default: null },
      notes: { type: String, default: null },
      correctedBy: { type: String, default: null },
      correctedAt: { type: Date, default: null }
    }
  },
  verification: {
    status: { type: String, enum: ["Pending", "Verified", "Duplicate", "Rejected"], default: "Pending" },
    verifiedBy: { type: String, default: null },
    verifiedAt: { type: Date, default: null },
    notes: { type: String, default: null }
  },
  // "Fraud Risk Score" (Part 35) — a real, deterministic 0-100 heuristic
  // (checksum-duplicate flag + OCR-vs-claimed amount mismatch + category
  // cap breach + submission velocity), the same style of scoring already
  // proven by Part 32's FinancialGovernanceService fraud rules — never an
  // ML claim.
  fraudRiskScore: { type: Number, default: 0 },
  fraudRiskFlags: { type: [String], default: [] },
  uploadedBy: { type: String, default: null },
  uploadedAt: { type: Date, default: Date.now }
}, { _id: true });

// "Expense Allocation Engine... Percentage Allocation... Allocation
// percentages must total 100%. Allocation history remains immutable after
// posting." Optional — a single-target expense (the pre-existing
// department/costCenter/projectId/businessUnit/branch fields) needs no
// allocation split; this array only exists once a caller explicitly
// splits one expense across multiple targets.
const ExpenseAllocationSchema = new mongoose.Schema({
  department: { type: mongoose.Schema.Types.ObjectId, ref: "department", default: null },
  costCenter: { type: String, default: null },
  projectId: { type: String, default: null },
  businessUnit: { type: String, default: null },
  branch: { type: String, default: null },
  percentage: { type: Number, required: true, min: 0.01, max: 100 },
  amount: { type: Number, required: true, min: 0 }
}, { _id: true });

const ExpenseSchema = new mongoose.Schema({
  tenantId: {
    type: String,
    required: true,
    index: true
  },
  expenseNumber: {
    type: String,
    required: true,
    immutable: true
  },
  // Finance does not own Users/Employees (same boundary discipline as
  // Customer/Vendor/Cash Location's own responsibleEmployeeId) — a real
  // ref, not ownership.
  employeeId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "user",
    required: true,
    index: true
  },
  employeeName: { type: String, default: null },
  // Real ref (models/Departmentmodel.js, already exists in this codebase
  // for HR/User purposes) — Finance references it, doesn't own it.
  department: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "department",
    default: null,
    index: true
  },
  // No Project/Cost Center/Business Unit/Branch module exists anywhere in
  // this codebase — kept as plain descriptive strings rather than a
  // fabricated ref to a collection that doesn't exist. None of these four
  // fields are ever used to scope or restrict data access; tenantId
  // remains the only isolation boundary in this codebase.
  projectId: { type: String, default: null },
  costCenter: { type: String, default: null },
  // "Profit Centre filtering" (Enterprise Expense Management Refactor Part
  // 3/4) — same descriptive-string treatment as costCenter/businessUnit
  // above (no ProfitCenterModel exists in this codebase either).
  profitCenter: { type: String, default: null },
  businessUnit: { type: String, default: null },
  branch: { type: String, default: null },
  tags: { type: [String], default: [] },
  // "Bulk Operations... Archive" — a real, honest metadata flag, distinct
  // from the `status` lifecycle (an archived expense keeps whatever status
  // it had; this only affects default list visibility). Never a lifecycle
  // transition of its own — Reimbursed/Closed remain the only real
  // terminal states.
  archived: { type: Boolean, default: false, index: true },
  archivedAt: { type: Date, default: null },
  archivedBy: { type: String, default: null },
  // "Bulk Operations... Comment" — free-text notes distinct from the
  // approval/verification/timeline notes already captured elsewhere on
  // this schema; never mutates after being added (append-only, matching
  // this schema's `timeline`/`approvals` append-only discipline).
  comments: [{
    text: { type: String, required: true },
    by: { type: String, default: null },
    at: { type: Date, default: Date.now }
  }],
  // "Bulk Operations... Assign Reviewer" — real, honest metadata only: this
  // codebase's RBAC has no per-user approver assignment (see
  // `approveExpense`'s own doc comment on why "next required level" is
  // permission-gated, not person-gated), so this field records who was
  // asked to look at the expense without pretending to gate `approveExpense`
  // itself.
  reviewerAssignment: {
    assignedTo: { type: String, default: null },
    assignedBy: { type: String, default: null },
    assignedAt: { type: Date, default: null },
    notes: { type: String, default: null }
  },
  // Optional multi-target split — see ExpenseAllocationSchema doc comment
  // above. Locked immutable once the expense is Approved (enforced in
  // ExpenseService, not at the schema layer, matching this codebase's
  // established "immutable after posting" enforcement style elsewhere).
  allocations: { type: [ExpenseAllocationSchema], default: [] },
  // Config-driven (expenseCategories) — the specific spend classification.
  category: { type: String, required: true, index: true },
  // "Configurable Expense Category Hierarchy... Level 1" (Part 44) — the
  // real, optional Level-1 grouping over `category` above, validated
  // against `expenseCategoryHierarchy`'s own keys when supplied. Optional:
  // omitting it (every pre-Part-44 caller) works exactly as before.
  categoryGroup: { type: String, default: null, index: true },
  // Config-driven (expenseTypes) — the higher-level ownership nature of
  // the spend (Employee/Operational/Project/Capital), distinct from and
  // orthogonal to `category` above.
  expenseType: { type: String, required: true, index: true },
  // The final claimed amount — COMPUTED from perDiem/mileage below when
  // either applies, never caller-supplied in that case.
  amount: { type: Number, required: true, min: 0.01 },
  currency: { type: String, required: true },
  // Real conversion via CurrencyService.convert (Part 19's own Conversion
  // Engine) — best-effort at Create/Update (never blocks a Draft save),
  // required to resolve before Submit. Null/null/null when `currency`
  // already equals the tenant's base currency (nothing to convert) or when
  // no rate has resolved yet.
  baseCurrency: { type: String, default: null },
  baseCurrencyAmount: { type: Number, default: null },
  exchangeRate: { type: Number, default: null },
  // "Multi-Currency Accounting... Rate Version." (File 7 Part 4) — real
  // rate-provenance snapshot from the same CurrencyService.convert call
  // above, previously computed and discarded (same gap Journal's own
  // exchangeRateId/Version/Provider already closed — Part 41). Null when
  // `currency` already equals the base currency (nothing was resolved
  // against a specific ExchangeRateModel row) or when triangulated
  // (no single row to point at).
  exchangeRateId: { type: mongoose.Schema.Types.ObjectId, ref: "exchange_rate", default: null },
  exchangeRateVersion: { type: Number, default: null },
  exchangeRateProvider: { type: String, default: null },
  exchangeRateType: { type: String, default: null },
  // ISO country code — the jurisdiction Tax Engine calculation needs.
  // Optional: no country means "skip tax calculation" (never fabricated),
  // the same discipline as every other optional config in this module.
  country: { type: String, default: null },
  // A real TaxRuleModel.taxCode (Part 8/20's own Tax Engine) — optional;
  // set only when this expense category is actually taxable for this
  // tenant's configured rules.
  taxCode: { type: String, default: null },
  tax: {
    taxCalculationId: { type: mongoose.Schema.Types.ObjectId, ref: "tax_calculation", default: null },
    taxRuleId: { type: mongoose.Schema.Types.ObjectId, default: null },
    taxType: { type: String, default: null },
    taxRate: { type: Number, default: null },
    taxAmount: { type: Number, default: 0 },
    // This codebase's TaxRuleModel doesn't yet distinguish recoverable vs.
    // non-recoverable tax (no such flag exists on it) — until it does,
    // calculated tax is treated as fully recoverable by default; both
    // fields exist per the spec's own ask, but their split isn't
    // independently computed. See docs/05-api/07-finance-api.md Part 35.
    recoverableTaxAmount: { type: Number, default: 0 },
    nonRecoverableTaxAmount: { type: Number, default: 0 },
    netAmount: { type: Number, default: null },
    grossAmount: { type: Number, default: null },
    calculatedAt: { type: Date, default: null }
  },
  expenseDate: { type: Date, required: true },
  description: { type: String, required: true },
  // Config-driven (expensePaymentMethods) — how the EMPLOYEE originally
  // paid. Distinct from `reimbursement.method` below (how the COMPANY
  // pays the employee back) — the whole point of this Part's own framing.
  paymentMethod: { type: String, default: null },
  corporateCard: {
    cardType: { type: String, default: null }, // Company Credit Card | Debit Card | Fuel Card | Virtual Card
    last4: { type: String, default: null },
    cardholderName: { type: String, default: null }
  },
  perDiem: {
    applicable: { type: Boolean, default: false },
    country: { type: String, default: null },
    days: { type: Number, default: null },
    dailyRate: { type: Number, default: null }
  },
  mileage: {
    applicable: { type: Boolean, default: false },
    distance: { type: Number, default: null },
    unit: { type: String, default: null },
    vehicleType: { type: String, default: null },
    rate: { type: Number, default: null }
  },
  attachments: [ExpenseAttachmentSchema],
  // Config-driven (expenseStatuses) — Draft, Submitted, Under Review,
  // Approved, Rejected, Cancelled, Returned, Reimbursed, Closed. See
  // utils/financeConfig.js's own doc comment for why "Manager Review"/
  // "Finance Review" aren't separate status values.
  status: {
    type: String,
    required: true,
    index: true
  },
  // Computed at submission from the amount-based policy — e.g.
  // ["Manager"], ["Manager","Finance"], or ["Manager","Finance","CFO"].
  requiredApprovalLevels: [{ type: String }],
  // Same ordered-multi-approval design as Part 15's CashTransferModel —
  // approvals must be recorded in the SAME order as requiredApprovalLevels
  // (sequential enforcement), not just any two/three distinct approvers.
  // Remains the source of truth for the expense's own lifecycle even when
  // `approvalRequestId` below is also set — see ApprovalWorkflowService
  // integration doc comment on `submitExpense`.
  approvals: [{
    level: { type: String, required: true },
    approvedBy: { type: String, required: true },
    approvedAt: { type: Date, default: Date.now },
    notes: { type: String, default: null }
  }],
  // Set only when a real, versioned ApprovalWorkflowDefinitionModel exists
  // for module "Expense" at submit time — routes the actual approve/reject
  // decision through ApprovalWorkflowService.recordDecision, gaining real
  // delegation-aware routing, escalation (via the already-running
  // approvalEscalationScheduler), and a real per-decision SHA-256 digital
  // signature hash — none of which this expense's own simplified
  // `approvals[]` array provides on its own.
  approvalRequestId: { type: mongoose.Schema.Types.ObjectId, ref: "approval_request", default: null },
  budgetCheck: {
    scope: { type: String, default: null }, // Department | Project | CostCenter
    scopeRef: { type: String, default: null },
    period: { type: String, default: null },
    allocatedAmount: { type: Number, default: null },
    consumedAmountBefore: { type: Number, default: null },
    exceeded: { type: Boolean, default: false },
    // "Budget Override" — set when a Finance/CFO approver knowingly
    // approves an expense despite `exceeded: true` (config
    // expenseBudgetEnforcement === "Warn"); real, not fabricated — only
    // ever true when an exceeded budget actually got approved anyway.
    overridden: { type: Boolean, default: false },
    checkedAt: { type: Date, default: null }
  },
  // Real, non-blocking-by-default flags from the Policy Engine — e.g.
  // "AmountExceedsCategoryLimit", "ReceiptMissingAboveThreshold".
  policyViolations: [{ type: String }],
  // Accrual-style GL recognition at Approval — "Expense Approved ->
  // Accounting Validation -> Journal Generated -> ... -> General Ledger
  // Posted" (the refactor spec's own diagram), crediting a payable rather
  // than cash directly. Only populated when both
  // expenseReimbursementExpenseAccountCode and
  // expenseReimbursementPayableAccountCode are configured; see
  // ExpenseService._postAccrualJournal.
  accrual: {
    journalId: { type: mongoose.Schema.Types.ObjectId, ref: "journal", default: null },
    postedAt: { type: Date, default: null }
  },
  reimbursement: {
    // Config-driven (reimbursementMethods) — Bank Transfer, Cash, Petty
    // Cash, Accounts Payable.
    method: { type: String, default: null },
    amount: { type: Number, default: null },
    currency: { type: String, default: null },
    // Polymorphic link to whichever real primitive actually moved the
    // money — a Part 13 BankTransactionModel (Bank Transfer), a Part 15
    // CashTransactionModel (Cash/Petty Cash), or a Part 6
    // AccountsPayableModel (Accounts Payable) — same no-`ref` discipline
    // as every other polymorphic sourceType/sourceId pair in this module.
    targetType: { type: String, default: null },
    targetId: { type: mongoose.Schema.Types.ObjectId, default: null },
    // Once `accrual.journalId` exists, this is the CLEARING journal (Dr
    // Employee Reimbursement Payable, Cr Bank/Cash/AP) — not a second
    // expense recognition. Falls back to the original Part 16 direct
    // Dr-Expense/Cr-Cash entry when no accrual was posted (account codes
    // not configured for this tenant).
    journalId: { type: mongoose.Schema.Types.ObjectId, ref: "journal", default: null },
    reimbursedBy: { type: String, default: null },
    reimbursedAt: { type: Date, default: null }
  },
  submittedBy: { type: String, default: null },
  submittedAt: { type: Date, default: null },
  rejectedBy: { type: String, default: null },
  rejectedAt: { type: Date, default: null },
  rejectionReason: { type: String, default: null },
  cancelledBy: { type: String, default: null },
  cancelledAt: { type: Date, default: null },
  cancellationReason: { type: String, default: null },
  returnedBy: { type: String, default: null },
  returnedAt: { type: Date, default: null },
  returnReason: { type: String, default: null },
  closedBy: { type: String, default: null },
  closedAt: { type: Date, default: null },
  timeline: [{
    event: { type: String, required: true },
    description: { type: String, default: null },
    performedBy: { type: String, default: null },
    performedAt: { type: Date, default: Date.now }
  }],
  createdBy: { type: String, default: null },
  updatedBy: { type: String, default: null }
}, { timestamps: true });

ExpenseSchema.index({ tenantId: 1, expenseNumber: 1 }, { unique: true });
ExpenseSchema.index({ tenantId: 1, employeeId: 1, status: 1 });
ExpenseSchema.index({ tenantId: 1, status: 1 });
ExpenseSchema.index({ tenantId: 1, category: 1 });
ExpenseSchema.index({ tenantId: 1, department: 1 });
ExpenseSchema.index({ tenantId: 1, expenseType: 1 });
ExpenseSchema.index({ tenantId: 1, expenseDate: 1 });
ExpenseSchema.index({ tenantId: 1, createdBy: 1 });
ExpenseSchema.index({ tenantId: 1, archived: 1, status: 1 });
ExpenseSchema.index({ tenantId: 1, costCenter: 1 });
ExpenseSchema.index({ tenantId: 1, profitCenter: 1 });
ExpenseSchema.index({ tenantId: 1, categoryGroup: 1 });

ExpenseSchema.set("toJSON", {
  transform: (_, ret) => {
    delete ret.__v;
    return ret;
  }
});

const ExpenseModel = mongoose.model("expense", ExpenseSchema);

export default ExpenseModel;
