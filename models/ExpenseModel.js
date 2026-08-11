import mongoose from "mongoose";

// Enterprise Expense Management — Finance Module Part 16. "The expense is
// not the payment. The reimbursement is the financial event." Tenant-
// scoped only — no branchId (see
// docs/06-external-integrations/03-final-architecture-no-branches-rbac.md;
// the spec's own "Branch Match"/"Branch Isolation" language is dropped per
// the standing master instructions — see docs/05-api/07-finance-api.md
// Part 16).
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
  uploadedBy: { type: String, default: null },
  uploadedAt: { type: Date, default: Date.now }
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
  // No Project/Cost Center module exists anywhere in this codebase — kept
  // as plain descriptive strings rather than a fabricated ref to a
  // collection that doesn't exist.
  projectId: { type: String, default: null },
  costCenter: { type: String, default: null },
  // Config-driven (expenseCategories).
  category: { type: String, required: true, index: true },
  // The final claimed amount — COMPUTED from perDiem/mileage below when
  // either applies, never caller-supplied in that case.
  amount: { type: Number, required: true, min: 0.01 },
  currency: { type: String, required: true },
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
  approvals: [{
    level: { type: String, required: true },
    approvedBy: { type: String, required: true },
    approvedAt: { type: Date, default: Date.now },
    notes: { type: String, default: null }
  }],
  budgetCheck: {
    scope: { type: String, default: null }, // Department | Project | CostCenter
    scopeRef: { type: String, default: null },
    period: { type: String, default: null },
    allocatedAmount: { type: Number, default: null },
    consumedAmountBefore: { type: Number, default: null },
    exceeded: { type: Boolean, default: false },
    checkedAt: { type: Date, default: null }
  },
  // Real, non-blocking-by-default flags from the Policy Engine — e.g.
  // "AmountExceedsCategoryLimit", "ReceiptMissingAboveThreshold".
  policyViolations: [{ type: String }],
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
ExpenseSchema.index({ tenantId: 1, expenseDate: 1 });

ExpenseSchema.set("toJSON", {
  transform: (_, ret) => {
    delete ret.__v;
    return ret;
  }
});

const ExpenseModel = mongoose.model("expense", ExpenseSchema);

export default ExpenseModel;
