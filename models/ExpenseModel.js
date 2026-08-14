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
  // SHA-256 of the raw file — "Duplicate Detection" runs against this,
  // real and deterministic, not a fuzzy OCR-based guess.
  checksum: { type: String, default: null },
  ocr: {
    status: { type: String, enum: ["Pending", "Completed", "Failed", "Skipped"], default: "Pending" },
    extractedText: { type: String, default: null },
    extractedAmount: { type: Number, default: null },
    extractedDate: { type: Date, default: null },
    extractedVendor: { type: String, default: null },
    confidence: { type: Number, default: null },
    processedAt: { type: Date, default: null }
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
  businessUnit: { type: String, default: null },
  branch: { type: String, default: null },
  tags: { type: [String], default: [] },
  // Optional multi-target split — see ExpenseAllocationSchema doc comment
  // above. Locked immutable once the expense is Approved (enforced in
  // ExpenseService, not at the schema layer, matching this codebase's
  // established "immutable after posting" enforcement style elsewhere).
  allocations: { type: [ExpenseAllocationSchema], default: [] },
  // Config-driven (expenseCategories) — the specific spend classification.
  category: { type: String, required: true, index: true },
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

ExpenseSchema.set("toJSON", {
  transform: (_, ret) => {
    delete ret.__v;
    return ret;
  }
});

const ExpenseModel = mongoose.model("expense", ExpenseSchema);

export default ExpenseModel;
