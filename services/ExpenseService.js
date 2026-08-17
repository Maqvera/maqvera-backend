import crypto from "crypto";
import mongoose from "mongoose";
import ExpenseModel from "../models/ExpenseModel.js";
import ExpenseBudgetModel from "../models/ExpenseBudgetModel.js";
import UserModel from "../models/Usermodel.js";
import DepartmentModel from "../models/Departmentmodel.js";
import VendorModel from "../models/VendorModel.js";
import BankAccountModel from "../models/BankAccountModel.js";
import CashLocationModel from "../models/CashLocationModel.js";
import BankAccountService from "./BankAccountService.js";
import CashManagementService from "./CashManagementService.js";
import AccountsPayableService from "./AccountsPayableService.js";
import AccountsPayableModel from "../models/AccountsPayableModel.js";
import JournalModel from "../models/JournalModel.js";
import JournalService from "./JournalService.js";
import FinancialPeriodService from "./FinancialPeriodService.js";
import FinanceSequenceModel from "../models/FinanceSequenceModel.js";
import AuditLogModel from "../models/AuditLogmodel.js";
import ExpenseOcrService from "./ExpenseOcrService.js";
import ApprovalWorkflowService from "./ApprovalWorkflowService.js";
import CommunicationPlatformService from "./CommunicationPlatformService.js";
import CurrencyService from "./CurrencyService.js";
import TaxService from "./TaxService.js";
import { storeDocumentPdf } from "../utils/documentPdfStorage.js";
import { publishEvent } from "../utils/eventBus.js";
import { getFinanceConfig } from "../utils/financeConfig.js";

const roundCurrency = (value) => Math.round((Number(value) || 0) * 100) / 100;

// ---------------------------------------------------------------------------
// Pure helpers — no DB access, unit-testable directly (see
// tests/expenseService.test.js).
// ---------------------------------------------------------------------------

/**
 * "Per Diem & Mileage... Daily Allowance... Country Rules." Falls back to
 * the "Default" rate when the country has no specific one configured.
 */
export const computePerDiemAmount = (country, days, config) => {
  if (!(days > 0)) throw new Error("Per diem days must be greater than zero.");
  const rate = config.perDiemRatesByCountry[country] ?? config.perDiemRatesByCountry.Default;
  if (rate === undefined) throw new Error(`No per diem rate configured for "${country}" and no Default rate set.`);
  return roundCurrency(rate * days);
};

/** "Mileage Rate... Vehicle Type... Distance Calculation." */
export const computeMileageAmount = (distance, vehicleType, config) => {
  if (!(distance > 0)) throw new Error("Mileage distance must be greater than zero.");
  const rate = config.mileageRatesByVehicleType[vehicleType];
  if (rate === undefined) throw new Error(`No mileage rate configured for vehicle type "${vehicleType}".`);
  return roundCurrency(rate * distance);
};

/**
 * "Approval Policies... Amount Based, Multi-level Approval." Manager
 * review is always required; Finance/CFO are added once the amount
 * reaches their configured threshold (0/unset = that tier never
 * required).
 */
export const computeRequiredApprovalLevels = (amount, config) => {
  const levels = ["Manager"];
  if (config.expenseApprovalThresholdFinance > 0 && amount >= config.expenseApprovalThresholdFinance) levels.push("Finance");
  if (config.expenseApprovalThresholdCFO > 0 && amount >= config.expenseApprovalThresholdCFO) levels.push("CFO");
  return levels;
};

/**
 * "Policy Engine" — real, hard-blocking checks (unlike Budget, below,
 * which is configurably soft). Returns the list of violated rules; an
 * empty array means the expense is policy-compliant.
 */
export const checkPolicyViolations = ({ category, amount, hasReceipt, config }) => {
  const violations = [];
  const categoryCap = config.expenseMaxAmountPerCategory?.[category];
  if (categoryCap !== undefined && amount > categoryCap) violations.push("AmountExceedsCategoryLimit");
  if (config.expenseReceiptRequiredAboveAmount >= 0 && amount >= config.expenseReceiptRequiredAboveAmount && !hasReceipt) violations.push("ReceiptMissingAboveThreshold");
  return violations;
};

/**
 * "Response Includes... Approval Status, Expense Status, Budget Status,
 * Accounting Status." `status` is the one real lifecycle field this
 * schema persists — these three are read-time-derived views over it (plus
 * `budgetCheck`/`reimbursement.journalId`), not separate mutable state.
 */
export const deriveApprovalStatus = (status) => {
  if (["Approved", "Reimbursed", "Closed"].includes(status)) return "Approved";
  if (status === "Under Review") return "PendingApproval";
  if (status === "Rejected") return "Rejected";
  return "NotSubmitted";
};

export const deriveBudgetStatus = (budgetCheck) => {
  if (!budgetCheck?.checkedAt) return "NotChecked";
  return budgetCheck.exceeded ? "Exceeded" : "WithinBudget";
};

/**
 * "Posted" once a real journal exists — either the new accrual journal
 * (posted at Approval) or, for expenses that predate/skip accrual, the
 * reimbursement journal. "ReimbursedNotPosted" honestly surfaces the real,
 * pre-existing gap where journal posting is skipped when the relevant
 * account code(s) aren't configured for this tenant — never silently
 * reported as "Posted" when it wasn't.
 */
export const deriveAccountingStatus = (expense) => {
  if (expense?.accrual?.journalId || expense?.reimbursement?.journalId) return "Posted";
  if (["Approved", "Reimbursed", "Closed"].includes(expense?.status)) return "ReimbursedNotPosted";
  return "NotPosted";
};

/**
 * "Reimbursement Status" (Enterprise Expense Management Refactor Part 3/4)
 * — a fourth real, read-time-derived view, same discipline as the other
 * three: never a separately-persisted, potentially-inconsistent field.
 */
export const deriveReimbursementStatus = (expense) => {
  if (["Rejected", "Cancelled"].includes(expense?.status)) return "NotApplicable";
  if (["Reimbursed", "Closed"].includes(expense?.status)) return "Reimbursed";
  if (expense?.status === "Approved") return "PendingReimbursement";
  return "NotYetApproved";
};

/** Real, deterministic rank mirroring `deriveApprovalStatus` exactly — used
 * only to sort by the derived `approvalStatus` in an aggregation pipeline
 * (Mongo can't sort by a JS-computed field via a plain `.find()`). */
const APPROVAL_STATUS_SORT_EXPR = {
  $switch: {
    branches: [
      { case: { $in: ["$status", ["Approved", "Reimbursed", "Closed"]] }, then: 2 },
      { case: { $eq: ["$status", "Under Review"] }, then: 1 },
      { case: { $eq: ["$status", "Rejected"] }, then: 3 }
    ],
    default: 0
  }
};

/**
 * "Fraud Risk Score" (Part 35's own Receipt Information ask) — a real,
 * deterministic 0-100 heuristic mirroring Part 32's
 * FinancialGovernanceService fraud-rule style (checksum-duplicate match,
 * an OCR-extracted amount that meaningfully disagrees with the claimed
 * amount, and the category's own configured max-amount cap breach). Never
 * an ML claim — a documented, reproducible score only.
 */
export const computeFraudRiskScore = ({ isDuplicate, ocrAmount, claimedAmount, categoryCap }) => {
  const flags = [];
  let score = 0;
  if (isDuplicate) { flags.push("DuplicateReceiptChecksum"); score += 50; }
  if (ocrAmount !== null && ocrAmount !== undefined && claimedAmount) {
    const diffPct = Math.abs(ocrAmount - claimedAmount) / claimedAmount;
    if (diffPct > 0.1) { flags.push("OcrAmountMismatch"); score += 25; }
  }
  if (categoryCap !== undefined && categoryCap !== null && claimedAmount > categoryCap) { flags.push("AmountExceedsCategoryLimit"); score += 25; }
  return { score: Math.min(100, score), flags };
};

/**
 * "Expense Allocation Engine... Allocation percentages must total 100%."
 * Pure validation — throws on the first violation found. An empty/absent
 * allocations array is always valid (single-target expenses need no
 * split).
 */
export const validateAllocations = (allocations, totalAmount) => {
  if (!allocations || allocations.length === 0) return;
  const totalPct = roundCurrency(allocations.reduce((sum, a) => sum + (a.percentage || 0), 0));
  if (totalPct !== 100) throw new Error(`Allocation percentages must total 100% (got ${totalPct}%).`);
  for (const a of allocations) {
    if (!(a.percentage > 0) || a.percentage > 100) throw new Error("Each allocation percentage must be greater than 0 and at most 100.");
    if (!a.department && !a.costCenter && !a.projectId && !a.businessUnit && !a.branch) {
      throw new Error("Each allocation requires at least one target (department, costCenter, projectId, businessUnit, or branch).");
    }
  }
  const computedTotal = roundCurrency(allocations.reduce((sum, a) => sum + roundCurrency((totalAmount * a.percentage) / 100), 0));
  if (Math.abs(computedTotal - roundCurrency(totalAmount)) > 0.05) {
    throw new Error(`Allocation amounts (${computedTotal}) do not reconcile with the expense total (${roundCurrency(totalAmount)}).`);
  }
};

/** Derives each allocation's real `amount` (percentage x total) — the schema itself stores this, never leaving it to be recomputed on every read. */
export const computeAllocationAmounts = (allocations, totalAmount) => {
  if (!allocations || allocations.length === 0) return [];
  return allocations.map((a) => ({ ...a, amount: roundCurrency((totalAmount * a.percentage) / 100) }));
};

/**
 * "Configurable Expense Category Hierarchy... Level 1 -> Level 2" (Part
 * 44) — pure validation that `category` (Level 2) actually belongs to the
 * supplied `categoryGroup` (Level 1) per the real, config-driven
 * `expenseCategoryHierarchy`. A no-op when `categoryGroup` isn't supplied
 * (every pre-Part-44 caller).
 */
export const validateCategoryGroup = (categoryGroup, category, hierarchy) => {
  if (!categoryGroup) return;
  const level2 = hierarchy[categoryGroup];
  if (!level2) throw new Error(`Invalid categoryGroup "${categoryGroup}".`);
  if (!level2.includes(category)) throw new Error(`Category "${category}" does not belong to categoryGroup "${categoryGroup}".`);
};

/** A budget `period` string is either a bare year ("2027") or a year-month ("2027-04"). */
export const doesPeriodContainDate = (period, date) => {
  const d = new Date(date);
  const year = d.getUTCFullYear();
  const month = String(d.getUTCMonth() + 1).padStart(2, "0");
  if (/^\d{4}$/.test(period)) return period === String(year);
  if (/^\d{4}-\d{2}$/.test(period)) return period === `${year}-${month}`;
  return false;
};

const EDITABLE_STATUSES = new Set(["Draft", "Returned"]);
const SUBMITTABLE_STATUSES = new Set(["Draft", "Returned"]);
const REJECTABLE_STATUSES = new Set(["Submitted", "Under Review"]);
const RETURNABLE_STATUSES = new Set(["Submitted", "Under Review"]);
// "Approved" is cancellable (Part 35) — with real automatic budget
// rollback and accrual-journal reversal (see cancelExpense) — because an
// approved-but-not-yet-reimbursed expense (e.g. the employee leaves the
// company) previously had no cancellation path at all, permanently
// stranding its consumed budget. "Reimbursed"/"Closed" remain terminal:
// once real cash has moved, only a reversing transaction can undo it, and
// none is modeled here (same discipline as every other posted-and-settled
// primitive in this codebase).
const CANCELLABLE_STATUSES = new Set(["Draft", "Submitted", "Under Review", "Returned", "Approved"]);
const RECEIPT_UPLOADABLE_BLOCKED_STATUSES = new Set(["Rejected", "Cancelled", "Closed"]);

export const isExpenseEditable = (status) => EDITABLE_STATUSES.has(status);
export const isExpenseSubmittable = (status) => SUBMITTABLE_STATUSES.has(status);
export const isExpenseApprovable = (status) => status === "Under Review";
export const isExpenseRejectable = (status) => REJECTABLE_STATUSES.has(status);
export const isExpenseReturnable = (status) => RETURNABLE_STATUSES.has(status);
export const isExpenseCancellable = (status) => CANCELLABLE_STATUSES.has(status);
export const isExpenseReimbursable = (status) => status === "Approved";
export const isExpenseCloseable = (status) => status === "Reimbursed";
export const isReceiptUploadable = (status) => !RECEIPT_UPLOADABLE_BLOCKED_STATUSES.has(status);

/**
 * "Approval History... Each approval contains Approver, Role, Decision,
 * Comments, Decision Time, Digital Signature, Approval SLA, Delegated
 * From, Escalated." Merges this expense's own real `approvals[]`
 * (level/approvedBy/approvedAt/notes — always present, the authoritative
 * lifecycle gate) with the matching decision on the real
 * `ApprovalRequestModel` (when one exists — see `submitExpense`'s own doc
 * comment on why the two aren't always both present) for the fields only
 * the real Approval Platform tracks: `signatureHash` (real per-decision
 * SHA-256, never fabricated), `decidedOnBehalfOf` ("Delegated From"), and
 * the resolved level's own `slaDeadline`/the request's `escalatedAt`.
 * Never guesses a match across levels of different names/order.
 */
export const buildApprovalHistory = (expense, approvalRequest) => {
  return (expense.approvals || []).map((approval, index) => {
    const decision = approvalRequest?.decisions?.[index];
    const level = approvalRequest?.levels?.[index];
    return {
      level: approval.level,
      approver: approval.approvedBy,
      decision: "Approved",
      comments: approval.notes,
      decidedAt: approval.approvedAt,
      signatureHash: decision?.signatureHash || null,
      delegatedFrom: decision?.decidedOnBehalfOf || null,
      slaDeadline: level?.slaDeadline || null,
      escalated: !!(approvalRequest?.escalatedAt && level && approvalRequest.escalatedAt <= (approval.approvedAt || new Date()))
    };
  });
};

const withDerivedStatuses = (expense) => ({
  ...expense,
  approvalStatus: deriveApprovalStatus(expense.status),
  budgetStatus: deriveBudgetStatus(expense.budgetCheck),
  accountingStatus: deriveAccountingStatus(expense),
  reimbursementStatus: deriveReimbursementStatus(expense)
});

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

class ExpenseService {
  static async _generateExpenseNumber(tenantId) {
    const config = getFinanceConfig();
    const year = `${new Date().getUTCFullYear()}`;
    const seq = await FinanceSequenceModel.getNext(tenantId, "expenseNumber", year);
    return `${config.expenseNumberPrefix}-${year}-${String(seq).padStart(6, "0")}`;
  }

  /**
   * POST /api/v1/expenses — "Draft" only. Policy/Budget/Approval Workflow
   * validation happens at `submitExpense`, not here — the spec's own
   * Business Workflow paragraph lists them as one flat pipeline, but the
   * Lifecycle diagram's own separate `Draft -> Submitted` states are the
   * real contract, the same reading already applied identically to every
   * gated-lifecycle module this session (Journal/Invoice/AP/Credit Note/
   * Debit Note/Refund/Bank Account/Bank Reconciliation/Cash Transfer).
   */
  static async createExpense(data, tenantId, userId, auditContext = {}) {
    const config = getFinanceConfig();
    const {
      employeeId, department = null, projectId = null, costCenter = null, profitCenter = null, businessUnit = null, branch = null, tags = [],
      allocations = [], category, categoryGroup = null, expenseType = config.defaultExpenseType, currency, expenseDate, description, paymentMethod = null,
      amount = null, perDiem = null, mileage = null, corporateCard = null, country = null, taxCode = null
    } = data;

    if (!employeeId || !category || !currency || !expenseDate || !description) {
      throw new Error("employeeId, category, currency, expenseDate, and description are required.");
    }
    if (!config.expenseCategories.includes(category)) throw new Error(`Invalid category "${category}".`);
    validateCategoryGroup(categoryGroup, category, config.expenseCategoryHierarchy);
    if (!config.expenseTypes.includes(expenseType)) throw new Error(`Invalid expenseType "${expenseType}".`);
    if (!config.supportedCurrencies.includes(currency)) throw new Error(`Unsupported currency "${currency}".`);
    if (paymentMethod && !config.expensePaymentMethods.includes(paymentMethod)) throw new Error(`Invalid paymentMethod "${paymentMethod}".`);

    // "Employee belongs to Company" (Part 34's own Validation Rules) — a
    // real, previously-missing tenant scope on this lookup; without it, any
    // tenant could attribute an expense to another tenant's employee.
    const employee = await UserModel.findOne({ _id: employeeId, tenantId }).lean();
    if (!employee) throw new Error("Employee not found.");

    if (department) {
      const departmentDoc = await DepartmentModel.findOne({ _id: department, tenantId }).lean();
      if (!departmentDoc) throw new Error("Department not found.");
    }

    let resolvedAmount = 0;
    const perDiemData = { applicable: false, country: null, days: null, dailyRate: null };
    const mileageData = { applicable: false, distance: null, unit: null, vehicleType: null, rate: null };

    if (perDiem?.applicable) {
      if (!perDiem.country || !perDiem.days) throw new Error("perDiem.country and perDiem.days are required when perDiem.applicable is true.");
      const dailyRate = config.perDiemRatesByCountry[perDiem.country] ?? config.perDiemRatesByCountry.Default;
      const perDiemAmount = computePerDiemAmount(perDiem.country, perDiem.days, config);
      resolvedAmount = roundCurrency(resolvedAmount + perDiemAmount);
      Object.assign(perDiemData, { applicable: true, country: perDiem.country, days: perDiem.days, dailyRate });
    }
    if (mileage?.applicable) {
      if (!mileage.distance || !mileage.vehicleType) throw new Error("mileage.distance and mileage.vehicleType are required when mileage.applicable is true.");
      const rate = config.mileageRatesByVehicleType[mileage.vehicleType];
      const mileageAmount = computeMileageAmount(mileage.distance, mileage.vehicleType, config);
      resolvedAmount = roundCurrency(resolvedAmount + mileageAmount);
      Object.assign(mileageData, { applicable: true, distance: mileage.distance, unit: config.mileageDistanceUnit, vehicleType: mileage.vehicleType, rate });
    }
    if (!perDiem?.applicable && !mileage?.applicable) {
      if (!amount || amount <= 0) throw new Error("A positive amount is required (or supply perDiem/mileage details).");
      resolvedAmount = roundCurrency(amount);
    }

    validateAllocations(allocations, resolvedAmount);
    const allocationsWithAmounts = computeAllocationAmounts(allocations, resolvedAmount);

    const expenseNumber = await ExpenseService._generateExpenseNumber(tenantId);
    const baseCurrencyFields = await ExpenseService._computeBaseCurrencyFields(resolvedAmount, currency, tenantId);

    const expense = await ExpenseModel.create({
      tenantId, expenseNumber, employeeId, employeeName: employee.username, department, projectId, costCenter, profitCenter, businessUnit, branch, tags, allocations: allocationsWithAmounts,
      category, categoryGroup, expenseType, amount: resolvedAmount, currency, ...baseCurrencyFields, country, taxCode, expenseDate: new Date(expenseDate), description, paymentMethod,
      corporateCard: corporateCard || undefined,
      perDiem: perDiemData, mileage: mileageData,
      status: config.defaultExpenseStatus,
      timeline: [{ event: "ExpenseCreated", description: `Draft expense ${expenseNumber} (${category}) created for ${employee.username}.`, performedBy: userId || null }],
      createdBy: userId || null,
      updatedBy: userId || null
    });

    await AuditLogModel.create({ action: "finance.expense.create", module: "Finance", resource: "Expense", resourceId: expense._id.toString(), userId: userId || null, tenantId, details: { expenseNumber, category, amount: resolvedAmount }, ...auditContext });
    publishEvent("ExpenseCreated", { tenantId, expenseId: expense._id.toString(), employeeId: employeeId.toString(), amount: resolvedAmount, currency, performedBy: userId || null });

    return expense.toJSON();
  }

  /**
   * Real conversion via CurrencyService (Part 19's own Conversion Engine).
   * Best-effort: never throws, never blocks a Draft save — a missing rate
   * simply leaves these null until one becomes available (recomputed on
   * every create/update, and required to resolve before Submit — see
   * `submitExpense`).
   */
  static async _computeBaseCurrencyFields(amount, currency, tenantId) {
    const baseCurrency = await CurrencyService.getBaseCurrency(tenantId);
    if (currency.toUpperCase() === baseCurrency.toUpperCase()) {
      return { baseCurrency, baseCurrencyAmount: amount, exchangeRate: 1, exchangeRateId: null, exchangeRateVersion: null, exchangeRateProvider: null, exchangeRateType: null };
    }
    try {
      const { convertedAmount, rate, rateId, rateVersion, rateProvider, rateType } = await CurrencyService.convert(amount, currency, baseCurrency, tenantId);
      return { baseCurrency, baseCurrencyAmount: convertedAmount, exchangeRate: rate, exchangeRateId: rateId, exchangeRateVersion: rateVersion, exchangeRateProvider: rateProvider, exchangeRateType: rateType };
    } catch {
      return { baseCurrency, baseCurrencyAmount: null, exchangeRate: null, exchangeRateId: null, exchangeRateVersion: null, exchangeRateProvider: null, exchangeRateType: null };
    }
  }

  /**
   * Real Tax Engine integration (Part 8/20's own TaxService) — only
   * attempted when the caller has actually supplied both `country` and
   * `taxCode` (tax is not applicable to every expense; skipping both is a
   * real, honest "not taxable"/"not configured" outcome, never a
   * fabricated zero). Once both are supplied, resolution is REQUIRED to
   * succeed — `TaxService.calculateTax` throws a real error when no
   * matching tax rule exists, and that error is allowed to propagate as a
   * real, blocking Submit-time validation failure ("Validate Tax Rules").
   */
  static async _computeTaxFields(expense, tenantId, userId) {
    if (!expense.country || !expense.taxCode) return null;
    const result = await TaxService.calculateTax({
      customerCountry: expense.country,
      currency: expense.currency,
      lines: [{ amount: expense.amount, taxCode: expense.taxCode }],
      transactionType: "Custom",
      transactionId: expense._id.toString(),
      transactionRef: expense.expenseNumber,
      direction: "Input"
    }, tenantId, userId);

    const line = result.lines[0];
    const taxAmount = roundCurrency(line.taxAmount);
    return {
      taxCalculationId: result._id,
      taxRuleId: line.taxRuleId,
      taxType: line.taxType,
      taxRate: line.taxRate,
      taxAmount,
      // See ExpenseModel.js's own doc comment: TaxRuleModel doesn't yet
      // distinguish recoverable vs. non-recoverable — treated as fully
      // recoverable by default until it does.
      recoverableTaxAmount: taxAmount,
      nonRecoverableTaxAmount: 0,
      netAmount: roundCurrency(line.taxBasis),
      grossAmount: roundCurrency(line.taxBasis + taxAmount),
      calculatedAt: new Date()
    };
  }

  /**
   * Shared by `listExpenses` and `exportExpenses` — "Advanced Filtering"
   * (Enterprise Expense Management Refactor Part 3/4). `approvalStatus`/
   * `accountingStatus`/`reimbursementStatus` are read-time-DERIVED (see
   * `deriveApprovalStatus`/`deriveAccountingStatus`/`deriveReimbursementStatus`
   * above) — filtering by them means translating the spec's own vocabulary
   * back into the real, underlying stored conditions those functions
   * derive from, never a second, independently-fabricated status field.
   * `merchant`/`subscription`/`company`/`branch`-as-isolation from the
   * spec are dropped — see ExpenseModel.js's own doc comment: no
   * Merchant/Subscription backing entity exists, `company` is redundant
   * with the caller's own `tenantId` scope, and `branch` (kept as a plain
   * filterable descriptive field, unchanged since Part 34) is never an
   * isolation boundary per the standing master instructions §3.
   */
  static _buildExpenseFilter(query, tenantId) {
    const {
      employeeId, department, category, categoryGroup, expenseType, status, businessUnit, branch, currency, costCenter, profitCenter,
      paymentMethod, createdBy, approvalStatus, accountingStatus, reimbursementStatus, archived, q
    } = query;
    const project = query.projectId || query.project;
    const filter = { tenantId };
    if (employeeId) filter.employeeId = employeeId;
    if (department) filter.department = department;
    if (category) filter.category = category;
    if (categoryGroup) filter.categoryGroup = categoryGroup;
    if (expenseType) filter.expenseType = expenseType;
    if (status) filter.status = status;
    if (project) filter.projectId = project;
    if (businessUnit) filter.businessUnit = businessUnit;
    if (branch) filter.branch = branch;
    if (currency) filter.currency = currency;
    if (costCenter) filter.costCenter = costCenter;
    if (profitCenter) filter.profitCenter = profitCenter;
    if (paymentMethod) filter.paymentMethod = paymentMethod;
    if (createdBy) filter.createdBy = createdBy;
    if (archived !== undefined) filter.archived = archived === true || archived === "true";
    if (query.dateFrom || query.dateTo) {
      filter.expenseDate = {};
      if (query.dateFrom) filter.expenseDate.$gte = new Date(query.dateFrom);
      if (query.dateTo) filter.expenseDate.$lte = new Date(query.dateTo);
    }

    const derivedConditions = [];
    if (approvalStatus) {
      const byApprovalStatus = {
        Approved: { status: { $in: ["Approved", "Reimbursed", "Closed"] } },
        PendingApproval: { status: "Under Review" },
        Rejected: { status: "Rejected" },
        NotSubmitted: { status: { $in: ["Draft", "Returned"] } }
      };
      if (byApprovalStatus[approvalStatus]) derivedConditions.push(byApprovalStatus[approvalStatus]);
    }
    if (accountingStatus) {
      const postedCondition = { $or: [{ "accrual.journalId": { $ne: null } }, { "reimbursement.journalId": { $ne: null } }] };
      const reimbursableStatuses = { status: { $in: ["Approved", "Reimbursed", "Closed"] } };
      if (accountingStatus === "Posted") derivedConditions.push(postedCondition);
      else if (accountingStatus === "ReimbursedNotPosted") derivedConditions.push(reimbursableStatuses, { "accrual.journalId": null, "reimbursement.journalId": null });
      else if (accountingStatus === "NotPosted") derivedConditions.push({ status: { $nin: ["Approved", "Reimbursed", "Closed"] } }, { "accrual.journalId": null, "reimbursement.journalId": null });
    }
    if (reimbursementStatus) {
      const byReimbursementStatus = {
        NotApplicable: { status: { $in: ["Rejected", "Cancelled"] } },
        Reimbursed: { status: { $in: ["Reimbursed", "Closed"] } },
        PendingReimbursement: { status: "Approved" },
        NotYetApproved: { status: { $in: ["Draft", "Submitted", "Under Review", "Returned"] } }
      };
      if (byReimbursementStatus[reimbursementStatus]) derivedConditions.push(byReimbursementStatus[reimbursementStatus]);
    }
    if (derivedConditions.length > 0) filter.$and = derivedConditions;

    // "Full Text Search" (Part 3/4) — a real, bounded convenience search
    // over the fields this schema actually stores (expenseNumber,
    // description, employeeName, tags). Comprehensive cross-module full
    // text search (OCR text, receipt/invoice/reference numbers) already
    // exists via the pre-existing Enterprise Search platform
    // (`GET /api/v1/search?entityType=Expense&q=...`, Part 28's
    // `SearchEngineService.indexExpense`) — not duplicated here.
    // Merchant/Subscription name search is dropped (no backing field).
    if (q) {
      const escaped = String(q).trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      if (escaped) {
        const regex = new RegExp(escaped, "i");
        filter.$or = [{ expenseNumber: regex }, { description: regex }, { employeeName: regex }, { tags: regex }];
      }
    }

    return filter;
  }

  static async listExpenses(query, tenantId) {
    const config = getFinanceConfig();
    const filter = ExpenseService._buildExpenseFilter(query, tenantId);
    const pageSize = Math.min(Math.max(parseInt(query.pageSize, 10) || config.defaultPageSize, 1), config.maxPageSize);

    // "Pagination... Cursor Pagination, Infinite Scroll" — a real, bounded
    // keyset alternative to offset pagination: sorted strictly by `_id`
    // descending (real, deterministic — the caller's own `sort` param is
    // not honored in cursor mode, since arbitrary-field keyset cursors
    // would require encoding that field's value too; documented rather
    // than faked). Offset pagination (`page`/`pageSize`) remains the
    // default and supports the caller's own `sort`.
    if (query.cursor) {
      if (!mongoose.Types.ObjectId.isValid(query.cursor)) throw new Error("Invalid cursor.");
      const cursorFilter = { ...filter, _id: { $lt: new mongoose.Types.ObjectId(query.cursor) } };
      const items = await ExpenseModel.find(cursorFilter).sort({ _id: -1 }).limit(pageSize + 1).lean();
      const hasMore = items.length > pageSize;
      const page = items.slice(0, pageSize);
      return { items: page.map(withDerivedStatuses), pagination: { pageSize, hasMore, nextCursor: hasMore ? page[page.length - 1]._id.toString() : null } };
    }

    const page = Math.max(parseInt(query.page, 10) || 1, 1);
    const skip = (page - 1) * pageSize;

    const sortField = query.sort ? query.sort.replace(/^-/, "") : "expenseDate";
    const sortDirection = query.sort?.startsWith("-") ? -1 : 1;

    // "Sorting... Approval Status" — `approvalStatus` isn't a stored field
    // (see `deriveApprovalStatus`'s own doc comment), so sorting by it
    // needs a real aggregation stage computing the identical rank via
    // `APPROVAL_STATUS_SORT_EXPR`, rather than silently ignoring the sort
    // request or fabricating a persisted duplicate field.
    if (sortField === "approvalStatus") {
      const [items, totalResult] = await Promise.all([
        ExpenseModel.aggregate([
          { $match: filter },
          { $addFields: { _approvalStatusRank: APPROVAL_STATUS_SORT_EXPR } },
          { $sort: { _approvalStatusRank: sortDirection, expenseDate: -1 } },
          { $skip: skip },
          { $limit: pageSize },
          { $project: { _approvalStatusRank: 0 } }
        ]),
        ExpenseModel.countDocuments(filter)
      ]);
      return { items: items.map(withDerivedStatuses), pagination: { total: totalResult, page, pageSize, totalPages: Math.ceil(totalResult / pageSize) } };
    }

    const [items, total] = await Promise.all([
      ExpenseModel.find(filter).sort({ [sortField]: sortDirection }).skip(skip).limit(pageSize).lean(),
      ExpenseModel.countDocuments(filter)
    ]);

    return { items: items.map(withDerivedStatuses), pagination: { total, page, pageSize, totalPages: Math.ceil(total / pageSize) } };
  }

  /**
   * GET /api/v1/expenses/export — "Bulk Operations... Export." Same CSV
   * hand-built escaping convention as `services/paymentFileGenerators/
   * CsvPaymentFileGenerator.js` / `BankReconciliationService.exportReportCsv`
   * (no csv-writer dependency exists in this codebase to reuse instead).
   * Reuses `_buildExpenseFilter` — export honors the exact same filters as
   * the list endpoint, capped at `expenseExportMaxRows` (a real, configured
   * safety bound, not an arbitrary in-code magic number).
   */
  static async exportExpenses(query, tenantId) {
    const config = getFinanceConfig();
    const filter = ExpenseService._buildExpenseFilter(query, tenantId);
    const items = await ExpenseModel.find(filter).sort({ expenseDate: -1 }).limit(config.expenseExportMaxRows).lean();

    const escapeCsvCell = (cell) => {
      const str = String(cell ?? "");
      return /[",\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
    };
    const header = ["Expense Number", "Employee", "Category", "Expense Type", "Department", "Cost Center", "Profit Center", "Project", "Business Unit", "Amount", "Currency", "Base Currency Amount", "Tax Amount", "Payment Method", "Status", "Approval Status", "Accounting Status", "Reimbursement Status", "Expense Date", "Created By", "Created At"];
    const rows = items.map((item) => [
      item.expenseNumber, item.employeeName, item.category, item.expenseType, item.department || "", item.costCenter || "", item.profitCenter || "", item.projectId || "", item.businessUnit || "",
      item.amount, item.currency, item.baseCurrencyAmount ?? "", item.tax?.taxAmount ?? 0, item.paymentMethod || "", item.status,
      deriveApprovalStatus(item.status), deriveAccountingStatus(item), deriveReimbursementStatus(item),
      new Date(item.expenseDate).toISOString().slice(0, 10), item.createdBy || "", new Date(item.createdAt).toISOString()
    ]);
    const csv = [header, ...rows].map((row) => row.map(escapeCsvCell).join(",")).join("\n");
    return { filename: `expenses-export-${Date.now()}.csv`, csv, rowCount: items.length };
  }

  // ---- Bulk Operations ----
  // "Bulk Operations... Subject to permissions." Every bulk method takes a
  // real, tenant-scoped array of expense ids and returns a real per-item
  // outcome (never a fabricated blanket success) — items that fail (not
  // found, wrong status, etc.) are reported individually rather than
  // aborting the whole batch.

  static async _runBulk(expenseIds, tenantId, itemFn) {
    const config = getFinanceConfig();
    if (!Array.isArray(expenseIds) || expenseIds.length === 0) throw new Error("expenseIds must be a non-empty array.");
    if (expenseIds.length > config.expenseBulkActionMaxItems) throw new Error(`A bulk action may target at most ${config.expenseBulkActionMaxItems} expenses at once.`);

    const results = [];
    for (const expenseId of expenseIds) {
      try {
        const result = await itemFn(expenseId);
        results.push({ expenseId, success: true, result });
      } catch (error) {
        results.push({ expenseId, success: false, error: error.message });
      }
    }
    return { results, succeeded: results.filter((r) => r.success).length, failed: results.filter((r) => !r.success).length };
  }

  static bulkApproveExpenses(expenseIds, data, tenantId, userId, auditContext) {
    return ExpenseService._runBulk(expenseIds, tenantId, (id) => ExpenseService.approveExpense(id, data, tenantId, userId, auditContext));
  }

  static bulkRejectExpenses(expenseIds, data, tenantId, userId, auditContext) {
    return ExpenseService._runBulk(expenseIds, tenantId, (id) => ExpenseService.rejectExpense(id, data, tenantId, userId, auditContext));
  }

  static bulkTagExpenses(expenseIds, tags, tenantId, userId, auditContext) {
    if (!Array.isArray(tags) || tags.length === 0) throw new Error("tags must be a non-empty array.");
    return ExpenseService._runBulk(expenseIds, tenantId, async (id) => {
      const expense = await ExpenseModel.findOne({ _id: id, tenantId });
      if (!expense) throw new Error("Expense not found.");
      expense.tags = Array.from(new Set([...(expense.tags || []), ...tags]));
      expense.updatedBy = userId || null;
      expense.timeline.push({ event: "ExpenseTagged", description: `Tags added: ${tags.join(", ")}.`, performedBy: userId || null });
      await expense.save();
      await AuditLogModel.create({ action: "finance.expense.bulk_tag", module: "Finance", resource: "Expense", resourceId: id.toString(), userId: userId || null, tenantId, details: { tags }, ...auditContext });
      return expense.toJSON();
    });
  }

  static bulkArchiveExpenses(expenseIds, tenantId, userId, auditContext) {
    return ExpenseService._runBulk(expenseIds, tenantId, async (id) => {
      const expense = await ExpenseModel.findOne({ _id: id, tenantId });
      if (!expense) throw new Error("Expense not found.");
      expense.archived = true;
      expense.archivedAt = new Date();
      expense.archivedBy = userId || null;
      expense.timeline.push({ event: "ExpenseArchived", description: "Expense archived.", performedBy: userId || null });
      await expense.save();
      await AuditLogModel.create({ action: "finance.expense.bulk_archive", module: "Finance", resource: "Expense", resourceId: id.toString(), userId: userId || null, tenantId, details: {}, ...auditContext });
      publishEvent("ExpenseArchived", { tenantId, expenseId: id.toString(), performedBy: userId || null });
      return expense.toJSON();
    });
  }

  static bulkCommentExpenses(expenseIds, text, tenantId, userId, auditContext) {
    if (!text || !text.trim()) throw new Error("text is required.");
    return ExpenseService._runBulk(expenseIds, tenantId, async (id) => {
      const expense = await ExpenseModel.findOne({ _id: id, tenantId });
      if (!expense) throw new Error("Expense not found.");
      expense.comments.push({ text, by: userId || null, at: new Date() });
      expense.timeline.push({ event: "ExpenseCommented", description: text, performedBy: userId || null });
      await expense.save();
      await AuditLogModel.create({ action: "finance.expense.bulk_comment", module: "Finance", resource: "Expense", resourceId: id.toString(), userId: userId || null, tenantId, details: { text }, ...auditContext });
      return expense.toJSON();
    });
  }

  static bulkAssignReviewer(expenseIds, { reviewerId, notes = null }, tenantId, userId, auditContext) {
    if (!reviewerId) throw new Error("reviewerId is required.");
    return ExpenseService._runBulk(expenseIds, tenantId, async (id) => {
      const expense = await ExpenseModel.findOne({ _id: id, tenantId });
      if (!expense) throw new Error("Expense not found.");
      expense.reviewerAssignment = { assignedTo: reviewerId, assignedBy: userId || null, assignedAt: new Date(), notes };
      expense.timeline.push({ event: "ExpenseReviewerAssigned", description: `Assigned to ${reviewerId} for review.`, performedBy: userId || null });
      await expense.save();
      await AuditLogModel.create({ action: "finance.expense.bulk_assign_reviewer", module: "Finance", resource: "Expense", resourceId: id.toString(), userId: userId || null, tenantId, details: { reviewerId }, ...auditContext });
      return expense.toJSON();
    });
  }

  /** Re-runs the same real budget match `submitExpense` uses, without
   * touching `status` — "Bulk Operations... Recalculate Budget" for an
   * already-submitted expense whose budget scope may have changed. */
  static async recalculateExpenseBudget(expenseId, tenantId, userId, auditContext = {}) {
    const expense = await ExpenseModel.findOne({ _id: expenseId, tenantId });
    if (!expense) throw new Error("Expense not found.");
    if (!["Under Review", "Approved"].includes(expense.status)) throw new Error(`Budget cannot be recalculated from status "${expense.status}".`);

    const config = getFinanceConfig();
    const matchingBudget = await ExpenseService._findMatchingBudget(tenantId, { department: expense.department, projectId: expense.projectId, costCenter: expense.costCenter }, expense.expenseDate);
    if (matchingBudget) {
      const projectedTotal = roundCurrency(matchingBudget.consumedAmount + expense.amount);
      const exceeded = projectedTotal > matchingBudget.allocatedAmount;
      expense.budgetCheck = { scope: matchingBudget.scope, scopeRef: matchingBudget.scopeRef, period: matchingBudget.period, allocatedAmount: matchingBudget.allocatedAmount, consumedAmountBefore: matchingBudget.consumedAmount, exceeded, overridden: expense.budgetCheck?.overridden || false, checkedAt: new Date() };
      if (exceeded && config.expenseBudgetEnforcement === "Block") publishEvent("BudgetExceeded", { tenantId, expenseId: expense._id.toString(), scope: matchingBudget.scope, scopeRef: matchingBudget.scopeRef, allocatedAmount: matchingBudget.allocatedAmount, projectedTotal, performedBy: userId || null });
    } else {
      expense.budgetCheck = { scope: null, scopeRef: null, period: null, allocatedAmount: null, consumedAmountBefore: null, exceeded: false, overridden: false, checkedAt: new Date() };
    }
    expense.timeline.push({ event: "ExpenseBudgetRecalculated", description: `Budget re-checked (${expense.budgetCheck.exceeded ? "exceeded" : "within budget"}).`, performedBy: userId || null });
    await expense.save();
    await AuditLogModel.create({ action: "finance.expense.recalculate_budget", module: "Finance", resource: "Expense", resourceId: expense._id.toString(), userId: userId || null, tenantId, details: { exceeded: expense.budgetCheck.exceeded }, ...auditContext });
    return expense.toJSON();
  }

  static bulkRecalculateBudget(expenseIds, tenantId, userId, auditContext) {
    return ExpenseService._runBulk(expenseIds, tenantId, (id) => ExpenseService.recalculateExpenseBudget(id, tenantId, userId, auditContext));
  }

  /** Re-runs the same real policy check `submitExpense` uses — "Bulk
   * Operations... Revalidate Policy." Non-blocking: updates
   * `policyViolations` for a human to see rather than throwing, since a
   * bulk revalidation pass is inherently a review action, not a gate. */
  static async revalidateExpensePolicy(expenseId, tenantId, userId, auditContext = {}) {
    const config = getFinanceConfig();
    const expense = await ExpenseModel.findOne({ _id: expenseId, tenantId });
    if (!expense) throw new Error("Expense not found.");

    const hasReceipt = expense.attachments.length > 0;
    const violations = checkPolicyViolations({ category: expense.category, amount: expense.amount, hasReceipt, config });
    expense.policyViolations = violations;
    expense.timeline.push({ event: "ExpensePolicyRevalidated", description: violations.length > 0 ? `Policy violation(s): ${violations.join(", ")}.` : "No policy violations found.", performedBy: userId || null });
    await expense.save();
    await AuditLogModel.create({ action: "finance.expense.revalidate_policy", module: "Finance", resource: "Expense", resourceId: expense._id.toString(), userId: userId || null, tenantId, details: { violations }, ...auditContext });
    return expense.toJSON();
  }

  static bulkRevalidatePolicy(expenseIds, tenantId, userId, auditContext) {
    return ExpenseService._runBulk(expenseIds, tenantId, (id) => ExpenseService.revalidateExpensePolicy(id, tenantId, userId, auditContext));
  }

  /**
   * GET /api/v1/expenses/{expenseId} — Part 35's own expanded "Response
   * Includes" list (Financial/Budget/Accounting/Reimbursement/Workflow/
   * Audit Information) is satisfied by the schema fields already stored
   * on the expense itself (Financial: baseCurrency/baseCurrencyAmount/
   * exchangeRate/tax.*; Budget: budgetCheck.*; Accounting:
   * accrual.journalId/reimbursement.journalId + accountingStatus;
   * Reimbursement: reimbursement.*; Audit: createdBy/timeline/
   * auditSummary below) plus the three derived statuses — no separate
   * "response shaping" layer was needed beyond that.
   */
  /**
   * GET /api/v1/expenses/{expenseId} — "360° view" (Enterprise Expense
   * Management Refactor Part 4/4). Reads the live aggregate document
   * itself, not the async-indexed `SearchIndexModel` (Part 28/42's own
   * real CQRS read model) — correct for a single-record detail view where
   * read-your-own-write consistency matters (e.g. right after an approval);
   * the search index remains the real read model for list/dashboard/search
   * use, unchanged. Cross-references (`journalId`/AP payable/vendor) are
   * resolved with real, tenant-scoped lookups — never populated with
   * fabricated placeholder data when the reference is absent.
   */
  static async getExpenseById(expenseId, tenantId) {
    const expense = await ExpenseModel.findOne({ _id: expenseId, tenantId }).lean();
    if (!expense) throw new Error("Expense not found.");

    const journalId = expense.accrual?.journalId || expense.reimbursement?.journalId || null;
    const isApPayable = expense.reimbursement?.targetType === "accounts_payable" && expense.reimbursement?.targetId;

    const [auditSummary, auditEventCount, approvalRequest, journal, apPayable, fiscalPeriod] = await Promise.all([
      AuditLogModel.find({ tenantId, resource: "Expense", resourceId: expense._id.toString() }).sort({ createdAt: -1 }).limit(20).lean(),
      AuditLogModel.countDocuments({ tenantId, resource: "Expense", resourceId: expense._id.toString() }),
      expense.approvalRequestId ? ApprovalWorkflowService.getApprovalRequestById(expense.approvalRequestId, tenantId).catch(() => null) : Promise.resolve(null),
      journalId ? JournalModel.findOne({ _id: journalId, tenantId }).lean().catch(() => null) : Promise.resolve(null),
      isApPayable ? AccountsPayableModel.findOne({ _id: expense.reimbursement.targetId, tenantId }).lean().catch(() => null) : Promise.resolve(null),
      FinancialPeriodService.findPeriodForDate(tenantId, expense.expenseDate).catch(() => null)
    ]);

    const vendor = apPayable?.vendorId ? await VendorModel.findOne({ _id: apPayable.vendorId, tenantId }).select("name currency").lean().catch(() => null) : null;

    // "Vendor Information (Optional)" — only ever populated when this
    // expense was actually reimbursed via Accounts Payable (the one real
    // vendor-referencing path this codebase has); "Vendor Category"/
    // "Vendor Tax Number" are dropped — no such fields exist on
    // `VendorModel` (see its own doc comment: deliberately minimal,
    // name/contact/terms/bankAccounts only).
    const vendorInformation = (apPayable && vendor) ? {
      vendorId: apPayable.vendorId, vendorName: vendor.name,
      vendorInvoice: apPayable.invoiceNumber, vendorReference: apPayable._id,
      vendorPayment: apPayable.status
    } : null;

    // "Accounting Information" — real, populated from the actual Journal
    // document `accrual.journalId`/`reimbursement.journalId` points at
    // (see ExpenseModel.js's own doc comments on both) rather than
    // fabricated. "Posting Status" collapses into the same real
    // `accountingStatus` already derived below (this codebase has one
    // real posting concept, not two independent ones).
    const accountingInformation = journal ? {
      journalId: journal._id, journalNumber: journal.journalNumber, postingDate: journal.postingDate,
      lines: (journal.lines || []).map((l) => ({ accountCode: l.accountCode, debit: l.debit, credit: l.credit })),
      postedBy: journal.postedBy, postingBatch: journal.batchId || null, reversalOf: journal.reversalOf || null,
      fiscalPeriod: fiscalPeriod ? { periodId: fiscalPeriod._id, name: fiscalPeriod.name || null, status: fiscalPeriod.status } : null
    } : { journalId: null, journalNumber: null, fiscalPeriod: fiscalPeriod ? { periodId: fiscalPeriod._id, name: fiscalPeriod.name || null, status: fiscalPeriod.status } : null };

    // "Budget Information" — real, from the `budgetCheck` snapshot taken
    // at Submit (see `submitExpense`). "Budget Name"/"Budget Version" are
    // dropped — `ExpenseBudgetModel` is deliberately lean (scope/scopeRef/
    // period/allocatedAmount/consumedAmount only, no name or version
    // field exists, by the same design as Part 24's original scoping).
    const budgetInformation = expense.budgetCheck?.checkedAt ? {
      scope: expense.budgetCheck.scope, scopeRef: expense.budgetCheck.scopeRef, period: expense.budgetCheck.period,
      budgetAvailable: expense.budgetCheck.allocatedAmount, budgetUsed: expense.budgetCheck.consumedAmountBefore,
      budgetRemaining: expense.budgetCheck.allocatedAmount !== null && expense.budgetCheck.consumedAmountBefore !== null ? roundCurrency(expense.budgetCheck.allocatedAmount - expense.budgetCheck.consumedAmountBefore) : null,
      validationResult: expense.budgetCheck.exceeded ? "Exceeded" : "WithinBudget",
      budgetOverride: expense.budgetCheck.overridden
    } : null;

    // "Cross-Module References" — real ids only, for whichever links
    // actually apply to this expense; Merchant/Subscription are always
    // omitted (no backing entity anywhere in this codebase).
    const crossModuleReferences = {
      budget: budgetInformation ? { scope: expense.budgetCheck.scope, scopeRef: expense.budgetCheck.scopeRef } : null,
      journal: journalId,
      ledger: journalId,
      payment: expense.reimbursement?.targetType === "bank_transaction" || expense.reimbursement?.targetType === "cash_transaction" ? expense.reimbursement.targetId : null,
      vendor: apPayable?.vendorId || null,
      employee: expense.employeeId,
      project: expense.projectId || null,
      approvalWorkflow: expense.approvalRequestId || null,
      audit: expense._id
    };

    return {
      ...withDerivedStatuses(expense),
      totalAmount: roundCurrency(expense.amount + (expense.tax?.taxAmount || 0)),
      approvalHistory: buildApprovalHistory(expense, approvalRequest),
      budgetInformation,
      accountingInformation,
      vendorInformation,
      crossModuleReferences,
      // "Immutable History Flag" — real, mirrors the actual enforced rule
      // (`isExpenseEditable`/the module's own "Immutable Accounting" rule):
      // true once the expense has reached a posted/terminal state.
      immutableHistory: !isExpenseEditable(expense.status) && ["Approved", "Reimbursed", "Closed"].includes(expense.status),
      auditSummary: { entries: auditSummary, eventCount: auditEventCount, correlationId: auditSummary[0]?.requestId || null, lastAuditTime: auditSummary[0]?.createdAt || null, approvedBy: expense.approvals?.[expense.approvals.length - 1]?.approvedBy || null, postedBy: journal?.postedBy || null },
      approvalRequest
    };
  }

  /**
   * PATCH /api/v1/expenses/{expenseId} — gap-fill, Draft/Returned only.
   */
  static async updateExpense(expenseId, data, tenantId, userId, auditContext = {}) {
    const config = getFinanceConfig();
    const expense = await ExpenseModel.findOne({ _id: expenseId, tenantId });
    if (!expense) throw new Error("Expense not found.");
    if (!isExpenseEditable(expense.status)) throw new Error(`Expense cannot be edited from status "${expense.status}".`);

    const { category, categoryGroup, expenseType, amount, currency, description, expenseDate, department, projectId, costCenter, profitCenter, businessUnit, branch, tags, allocations, paymentMethod, country, taxCode } = data;
    if (category !== undefined) {
      if (!config.expenseCategories.includes(category)) throw new Error(`Invalid category "${category}".`);
      expense.category = category;
    }
    if (categoryGroup !== undefined) {
      validateCategoryGroup(categoryGroup, category !== undefined ? category : expense.category, config.expenseCategoryHierarchy);
      expense.categoryGroup = categoryGroup;
    }
    if (expenseType !== undefined) {
      if (!config.expenseTypes.includes(expenseType)) throw new Error(`Invalid expenseType "${expenseType}".`);
      expense.expenseType = expenseType;
    }
    let recomputeBaseCurrency = false;
    if (amount !== undefined) { expense.amount = roundCurrency(amount); recomputeBaseCurrency = true; }
    if (currency !== undefined) {
      if (!config.supportedCurrencies.includes(currency)) throw new Error(`Unsupported currency "${currency}".`);
      expense.currency = currency;
      recomputeBaseCurrency = true;
    }
    if (recomputeBaseCurrency) {
      const baseCurrencyFields = await ExpenseService._computeBaseCurrencyFields(expense.amount, expense.currency, tenantId);
      expense.baseCurrency = baseCurrencyFields.baseCurrency;
      expense.baseCurrencyAmount = baseCurrencyFields.baseCurrencyAmount;
      expense.exchangeRate = baseCurrencyFields.exchangeRate;
      expense.exchangeRateId = baseCurrencyFields.exchangeRateId;
      expense.exchangeRateVersion = baseCurrencyFields.exchangeRateVersion;
      expense.exchangeRateProvider = baseCurrencyFields.exchangeRateProvider;
      expense.exchangeRateType = baseCurrencyFields.exchangeRateType;
    }
    if (description !== undefined) expense.description = description;
    if (expenseDate !== undefined) expense.expenseDate = new Date(expenseDate);
    if (department !== undefined) expense.department = department;
    if (projectId !== undefined) expense.projectId = projectId;
    if (costCenter !== undefined) expense.costCenter = costCenter;
    if (profitCenter !== undefined) expense.profitCenter = profitCenter;
    if (businessUnit !== undefined) expense.businessUnit = businessUnit;
    if (branch !== undefined) expense.branch = branch;
    if (tags !== undefined) expense.tags = tags;
    if (country !== undefined) expense.country = country;
    if (taxCode !== undefined) expense.taxCode = taxCode;
    if (allocations !== undefined) {
      validateAllocations(allocations, expense.amount);
      expense.allocations = computeAllocationAmounts(allocations, expense.amount);
    }
    if (paymentMethod !== undefined) {
      if (paymentMethod && !config.expensePaymentMethods.includes(paymentMethod)) throw new Error(`Invalid paymentMethod "${paymentMethod}".`);
      expense.paymentMethod = paymentMethod;
    }

    expense.updatedBy = userId || null;
    expense.timeline.push({ event: "ExpenseUpdated", description: "Expense details updated.", performedBy: userId || null });
    await expense.save();

    await AuditLogModel.create({ action: "finance.expense.update", module: "Finance", resource: "Expense", resourceId: expense._id.toString(), userId: userId || null, tenantId, details: {}, ...auditContext });

    return expense.toJSON();
  }

  /**
   * POST /api/v1/expenses/{expenseId}/receipts — "Receipt Management...
   * Image Upload, PDF Upload, OCR Extraction, Duplicate Detection,
   * Receipt Verification, Long-term Archive." Duplicate detection is a
   * real SHA-256 checksum match against this same employee's other
   * receipts — not a fuzzy OCR-based guess. Fraud Risk Score (Part 35) is
   * computed from that same duplicate flag plus the real OCR-extracted
   * amount vs. the expense's own claimed amount.
   */
  static async uploadReceipt(expenseId, file, tenantId, userId, auditContext = {}) {
    const config = getFinanceConfig();
    if (!file?.buffer?.length) throw new Error("A receipt file is required.");
    if (file.buffer.length > config.expenseReceiptMaxFileSizeBytes) {
      throw new Error(`Receipt file exceeds the maximum allowed size of ${config.expenseReceiptMaxFileSizeBytes} bytes.`);
    }

    const expense = await ExpenseModel.findOne({ _id: expenseId, tenantId });
    if (!expense) throw new Error("Expense not found.");
    if (!isReceiptUploadable(expense.status)) throw new Error(`Receipts cannot be uploaded to an expense in status "${expense.status}".`);

    const checksum = crypto.createHash("sha256").update(file.buffer).digest("hex");
    const duplicate = await ExpenseModel.exists({ tenantId, employeeId: expense.employeeId, "attachments.checksum": checksum });

    const stored = await storeDocumentPdf({ tenantId, folder: "expense-receipts", filename: `${expense.expenseNumber}-${Date.now()}-${(file.originalname || "receipt").replace(/[^a-zA-Z0-9._-]/g, "_")}`, buffer: file.buffer });

    const ocr = config.expenseOcrEnabled ? await ExpenseOcrService.processAttachment(file.buffer, file.mimetype) : { status: "Skipped", extractedText: null, extractedAmount: null, extractedDate: null, extractedVendor: null, confidence: null, processedAt: new Date() };

    const { score: fraudRiskScore, flags: fraudRiskFlags } = computeFraudRiskScore({
      isDuplicate: !!duplicate,
      ocrAmount: ocr.extractedAmount,
      claimedAmount: expense.amount,
      categoryCap: config.expenseMaxAmountPerCategory?.[expense.category]
    });

    const attachment = {
      filename: file.originalname || "receipt", url: stored.url, storageKey: stored.storageKey, storageProvider: stored.storageProvider,
      mimeType: file.mimetype, fileSize: file.buffer.length, checksum, ocr,
      // Real, honest per-attachment security metadata — see
      // ExpenseModel.js's own doc comments on both fields for why these
      // specific values, not "clean"/encrypted-everywhere fabrications.
      virusScanStatus: "skipped",
      encryptionStatus: ["cloudinary", "s3"].includes(stored.storageProvider) ? "AtRestServerSide" : "None",
      verification: { status: duplicate ? "Duplicate" : "Pending", verifiedBy: null, verifiedAt: null, notes: duplicate ? "Matches the checksum of another receipt already on file for this employee." : null },
      fraudRiskScore, fraudRiskFlags,
      uploadedBy: userId || null, uploadedAt: new Date()
    };
    expense.attachments.push(attachment);
    // Mongoose assigns the real subdocument `_id` on the CAST array
    // element, not the plain object literal `attachment` still points at
    // (verified: pushing a plain object never mutates it with `_id`) —
    // this is the one real reference used for the events published below.
    const savedAttachment = expense.attachments[expense.attachments.length - 1];
    expense.timeline.push({ event: "ReceiptUploaded", description: `Receipt "${attachment.filename}" uploaded${duplicate ? " (possible duplicate)" : ""}${fraudRiskScore > 0 ? ` (fraud risk score: ${fraudRiskScore})` : ""}.`, performedBy: userId || null });
    // "Timeline... Receipt Uploaded -> OCR Completed" (Part 4/4) — a
    // distinct timeline entry for the real OCR outcome, alongside the
    // ReceiptUploaded entry above (the pre-existing `OCRCompleted` domain
    // event already fires; this only adds the matching visible timeline
    // row the spec's own example lists as a separate step).
    if (ocr.status === "Completed") expense.timeline.push({ event: "OCRCompleted", description: `OCR extracted${ocr.extractedVendor ? ` vendor "${ocr.extractedVendor}"` : ""}${ocr.extractedAmount ? `, amount ${ocr.extractedAmount}` : ""}${ocr.confidence !== null ? ` (confidence ${ocr.confidence})` : ""}.`, performedBy: "system" });
    await expense.save();

    await AuditLogModel.create({ action: "finance.expense.upload_receipt", module: "Finance", resource: "Expense", resourceId: expense._id.toString(), userId: userId || null, tenantId, details: { filename: attachment.filename, ocrStatus: ocr.status, duplicate: !!duplicate, fraudRiskScore }, ...auditContext });
    // "Receipt Uploaded" / "Duplicate Detected" (Part 44) — the two real
    // events named first in the spec's own Receipt Lifecycle diagram, at
    // the same real upload/checksum-match this method already performs.
    publishEvent("ReceiptUploaded", { tenantId, expenseId: expense._id.toString(), attachmentId: savedAttachment._id.toString(), filename: attachment.filename, performedBy: userId || null });
    if (duplicate) publishEvent("ReceiptDuplicateDetected", { tenantId, expenseId: expense._id.toString(), attachmentId: savedAttachment._id.toString(), performedBy: userId || null });
    if (ocr.status === "Completed") publishEvent("OCRCompleted", { tenantId, expenseId: expense._id.toString(), extractedAmount: ocr.extractedAmount, extractedVendor: ocr.extractedVendor, performedBy: userId || null });
    // "Fraud Detection" (Part 44) — `FraudRiskDetected` below IS the real
    // "ReceiptFraudDetected" event from the spec's own new-events list;
    // kept under its pre-existing Part 35 name rather than publishing a
    // second, redundant event for the identical detection.
    if (fraudRiskScore >= config.expenseFraudRiskScoreThreshold) publishEvent("FraudRiskDetected", { tenantId, expenseId: expense._id.toString(), fraudRiskScore, fraudRiskFlags, performedBy: userId || null });

    return expense.toJSON();
  }

  /**
   * POST /api/v1/expenses/{expenseId}/receipts/{attachmentId}/verify —
   * gap-fill for the named `ReceiptVerified` event.
   */
  static async verifyReceipt(expenseId, attachmentId, data, tenantId, userId, auditContext = {}) {
    const { status, notes = null } = data;
    if (!["Verified", "Duplicate", "Rejected"].includes(status)) throw new Error('status must be "Verified", "Duplicate", or "Rejected".');

    const expense = await ExpenseModel.findOne({ _id: expenseId, tenantId });
    if (!expense) throw new Error("Expense not found.");
    const attachment = expense.attachments.id(attachmentId);
    if (!attachment) throw new Error("Attachment not found.");

    attachment.verification = { status, verifiedBy: userId || null, verifiedAt: new Date(), notes };
    expense.timeline.push({ event: "ReceiptVerificationUpdated", description: `Receipt "${attachment.filename}" marked ${status}.`, performedBy: userId || null });
    await expense.save();

    await AuditLogModel.create({ action: "finance.expense.verify_receipt", module: "Finance", resource: "Expense", resourceId: expense._id.toString(), userId: userId || null, tenantId, details: { attachmentId: attachmentId.toString(), status }, ...auditContext });
    if (status === "Verified") publishEvent("ReceiptVerified", { tenantId, expenseId: expense._id.toString(), attachmentId: attachmentId.toString(), performedBy: userId || null });

    return expense.toJSON();
  }

  /**
   * POST /api/v1/expenses/{expenseId}/receipts/{attachmentId}/correct-ocr —
   * "OCR Information... Manual Corrections." A human-supplied override,
   * kept alongside (never overwriting) the original machine-extracted
   * `ocr.extracted*` fields, so a reviewer can always see both.
   */
  static async correctReceiptOcr(expenseId, attachmentId, data, tenantId, userId, auditContext = {}) {
    const { amount = null, vendor = null, date = null, receiptNumber = null, notes = null } = data;
    if (amount === null && vendor === null && date === null && receiptNumber === null) {
      throw new Error("At least one of amount, vendor, date, or receiptNumber is required.");
    }

    const expense = await ExpenseModel.findOne({ _id: expenseId, tenantId });
    if (!expense) throw new Error("Expense not found.");
    const attachment = expense.attachments.id(attachmentId);
    if (!attachment) throw new Error("Attachment not found.");

    attachment.ocr.manualCorrection = { amount, vendor, date: date ? new Date(date) : null, receiptNumber, notes, correctedBy: userId || null, correctedAt: new Date() };
    expense.timeline.push({ event: "ReceiptOcrCorrected", description: `Manual OCR correction recorded for "${attachment.filename}".`, performedBy: userId || null });
    await expense.save();

    await AuditLogModel.create({ action: "finance.expense.correct_ocr", module: "Finance", resource: "Expense", resourceId: expense._id.toString(), userId: userId || null, tenantId, details: { attachmentId: attachmentId.toString(), amount, vendor, receiptNumber }, ...auditContext });
    return expense.toJSON();
  }

  static async _findMatchingBudget(tenantId, { department, projectId, costCenter }, expenseDate) {
    const candidates = [];
    if (department) candidates.push({ scope: "Department", scopeRef: department.toString() });
    if (projectId) candidates.push({ scope: "Project", scopeRef: projectId });
    if (costCenter) candidates.push({ scope: "CostCenter", scopeRef: costCenter });

    for (const { scope, scopeRef } of candidates) {
      const budgets = await ExpenseBudgetModel.find({ tenantId, scope, scopeRef }).lean();
      const match = budgets.find((b) => doesPeriodContainDate(b.period, expenseDate));
      if (match) return match;
    }
    return null;
  }

  /**
   * POST /api/v1/expenses/{expenseId}/submit
   * Validate Currency -> Validate Tax -> Validate Policy -> Validate
   * Budget -> Approval Workflow (levels computed, real request started
   * when a matching definition exists) -> Publish ExpenseSubmitted.
   */
  static async submitExpense(expenseId, tenantId, userId, auditContext = {}) {
    const config = getFinanceConfig();
    const expense = await ExpenseModel.findOne({ _id: expenseId, tenantId });
    if (!expense) throw new Error("Expense not found.");
    if (!isExpenseSubmittable(expense.status)) throw new Error(`Expense cannot be submitted from status "${expense.status}".`);

    await FinancialPeriodService.assertPeriodOpen(tenantId, expense.expenseDate);

    // "Validate Currency... Exchange Rate Available" — a real, blocking
    // gate at Submit, matching how Policy/Budget are already gated here
    // rather than at Create. A missing rate never blocks saving a Draft,
    // but it does block sending one for approval.
    if (expense.baseCurrencyAmount === null) {
      const retry = await ExpenseService._computeBaseCurrencyFields(expense.amount, expense.currency, tenantId);
      if (retry.baseCurrencyAmount === null) {
        throw new Error(`No exchange rate available for ${expense.currency} -> ${retry.baseCurrency}; cannot submit for approval.`);
      }
      expense.baseCurrency = retry.baseCurrency;
      expense.baseCurrencyAmount = retry.baseCurrencyAmount;
      expense.exchangeRate = retry.exchangeRate;
      expense.exchangeRateId = retry.exchangeRateId;
      expense.exchangeRateVersion = retry.exchangeRateVersion;
      expense.exchangeRateProvider = retry.exchangeRateProvider;
      expense.exchangeRateType = retry.exchangeRateType;
    }

    // "Validate Tax Rules" — real Tax Engine integration (see
    // `_computeTaxFields`'s own doc comment). A required, blocking
    // calculation only when the caller supplied both country and taxCode;
    // otherwise tax is honestly not applicable and stays zeroed.
    const taxFields = await ExpenseService._computeTaxFields(expense, tenantId, userId);
    if (taxFields) expense.tax = taxFields;

    const hasReceipt = expense.attachments.length > 0;
    const violations = checkPolicyViolations({ category: expense.category, amount: expense.amount, hasReceipt, config });
    if (violations.length > 0) throw new Error(`Policy violation(s): ${violations.join(", ")}.`);
    expense.policyViolations = [];

    const matchingBudget = await ExpenseService._findMatchingBudget(tenantId, { department: expense.department, projectId: expense.projectId, costCenter: expense.costCenter }, expense.expenseDate);
    if (matchingBudget) {
      const projectedTotal = roundCurrency(matchingBudget.consumedAmount + expense.amount);
      const exceeded = projectedTotal > matchingBudget.allocatedAmount;
      expense.budgetCheck = { scope: matchingBudget.scope, scopeRef: matchingBudget.scopeRef, period: matchingBudget.period, allocatedAmount: matchingBudget.allocatedAmount, consumedAmountBefore: matchingBudget.consumedAmount, exceeded, overridden: false, checkedAt: new Date() };
      if (exceeded) {
        if (config.expenseBudgetEnforcement === "Block") {
          throw new Error(`Budget exceeded for ${matchingBudget.scope} "${matchingBudget.scopeRef}" (${matchingBudget.period}): allocated ${matchingBudget.allocatedAmount}, projected ${projectedTotal}.`);
        }
        publishEvent("BudgetExceeded", { tenantId, expenseId: expense._id.toString(), scope: matchingBudget.scope, scopeRef: matchingBudget.scopeRef, allocatedAmount: matchingBudget.allocatedAmount, projectedTotal, performedBy: userId || null });
      }
      // "Budget Validated" (Part 44) — fires on every real budget check at
      // Submit, whether or not it exceeded (`BudgetExceeded` above remains
      // the separate, exceeded-only event).
      publishEvent("BudgetValidated", { tenantId, expenseId: expense._id.toString(), scope: matchingBudget.scope, scopeRef: matchingBudget.scopeRef, exceeded, performedBy: userId || null });
    } else {
      expense.budgetCheck = { scope: null, scopeRef: null, period: null, allocatedAmount: null, consumedAmountBefore: null, exceeded: false, overridden: false, checkedAt: new Date() };
    }

    // Finance Module Part 22 — "every module should ask a centralized
    // [...] Engine" instead of computing its own approval chain. Tries
    // the real, versioned `ApprovalWorkflowDefinitionModel` first (a
    // tenant admin can now define/version Expense's own Manager/Finance/
    // CFO chain — or a completely different one — without a code
    // change); falls back to the original, still-real, config-driven
    // `computeRequiredApprovalLevels` (untouched, still exported/tested)
    // when no matching definition exists yet for this tenant.
    const resolvedLevels = await ApprovalWorkflowService.resolveApprovalLevels("Expense", { amount: expense.amount, department: expense.department }, tenantId);
    expense.requiredApprovalLevels = resolvedLevels || computeRequiredApprovalLevels(expense.amount, config);
    expense.approvals = [];

    // Part 35 — when a real definition exists, also start a real
    // ApprovalRequestModel (ApprovalWorkflowService.startApproval), so
    // this expense gains real SLA/escalation tracking (the already-running
    // approvalEscalationScheduler will process it) for free. This
    // expense's own status/approvals[] above remains the authoritative
    // gate for its lifecycle; approveExpense/rejectExpense best-effort
    // attempt to record the matching decision on this real request too
    // (real digital-signature hash when it succeeds), but never depend on
    // it succeeding — see their own doc comments for why.
    expense.approvalRequestId = null;
    if (resolvedLevels) {
      try {
        const request = await ApprovalWorkflowService.startApproval({
          module: "Expense", entityId: expense._id, entityRef: expense.expenseNumber,
          context: { amount: expense.amount, department: expense.department ? expense.department.toString() : null }
        }, tenantId, userId);
        expense.approvalRequestId = request._id;
      } catch {
        // No real definition matched after all (e.g. a Conditional
        // definition whose branches don't match this context) — the
        // expense's own fallback approvals[] tracking below still works.
      }
    }

    expense.submittedBy = userId || null;
    expense.submittedAt = new Date();
    expense.status = "Under Review";
    expense.updatedBy = userId || null;
    expense.timeline.push({ event: "ExpenseSubmitted", description: `Submitted for approval (${expense.requiredApprovalLevels.join(" -> ")}).`, performedBy: userId || null });
    await expense.save();

    await AuditLogModel.create({ action: "finance.expense.submit", module: "Finance", resource: "Expense", resourceId: expense._id.toString(), userId: userId || null, tenantId, details: { requiredApprovalLevels: expense.requiredApprovalLevels, budgetExceeded: expense.budgetCheck.exceeded, taxAmount: expense.tax?.taxAmount || 0 }, ...auditContext });
    publishEvent("ExpenseSubmitted", { tenantId, expenseId: expense._id.toString(), employeeId: expense.employeeId.toString(), amount: expense.amount, requiredApprovalLevels: expense.requiredApprovalLevels, performedBy: userId || null });
    await ExpenseService._notifyExpenseOwner(expense, { subject: `Expense ${expense.expenseNumber} submitted for approval`, content: `Your expense "${expense.description}" (${expense.amount} ${expense.currency}) was submitted and is pending ${expense.requiredApprovalLevels.join(" -> ")} approval.` }, tenantId);

    return expense.toJSON();
  }

  /**
   * Best-effort mirror of an Expense-level decision onto its real
   * ApprovalRequestModel (when one exists). `ApprovalWorkflowService
   * .recordDecision` has its own independent approver-resolution (only a
   * request's actually-assigned approvers/delegates may decide) that this
   * codebase has no guarantee lines up 1:1 with whoever holds
   * `finance.expense.approve` — so a failure here (e.g. "not an assigned
   * approver") is expected and silently ignored; it never blocks or
   * reverses the caller's real decision already recorded on the expense
   * itself. Success gains a real per-decision SHA-256 digital signature
   * hash and, on a terminal expense outcome, closes out the request
   * cleanly instead of leaving it orphaned Pending forever.
   */
  static async _mirrorDecisionToApprovalRequest(expense, decision, comments, tenantId, userId) {
    if (!expense.approvalRequestId) return;
    try {
      await ApprovalWorkflowService.recordDecision(expense.approvalRequestId, { decision, comments }, tenantId, userId);
    } catch {
      // Expected when this approver isn't resolvable on the real request — see doc comment above.
    }
  }

  /**
   * "Notifications... Expense Submitted, Expense Returned, Expense
   * Approved, Expense Rejected, Reimbursement Completed, Expense Closed"
   * (Part 44) — real delivery via the already-real, generic
   * `CommunicationPlatformService` (Email/SMS/WhatsApp/Push/InApp/Webhook
   * adapters all genuinely implemented, not this method's own concern).
   * Targets the expense OWNER only — this codebase's approval is
   * permission-gated, not person-assigned (see `approveExpense`'s own doc
   * comment), so there is no real "the approver" user to resolve and
   * notify; notifying a fictional one would be fabricated. "Budget
   * Exceeded"/"Receipt Missing" are not wired here — the first already has
   * no real approver-identity to reach either, and the second is enforced
   * as a synchronous blocking validation at Submit, never a standalone
   * async reminder. Best-effort: a delivery failure never blocks the real
   * business transaction it's reporting on.
   */
  static async _notifyExpenseOwner(expense, { subject, content, priority = "Normal" }, tenantId) {
    try {
      const employee = await UserModel.findOne({ _id: expense.employeeId, tenantId }).select("email").lean();
      if (!employee?.email) return;
      await CommunicationPlatformService.requestCommunication({
        tenantId, sourceModule: "Finance", channel: "Email",
        recipient: { userId: expense.employeeId.toString(), email: employee.email },
        subject, content, priority
      });
    } catch {
      // Notification delivery is never allowed to fail the real expense transaction it's reporting on.
    }
  }

  static async _closeApprovalRequest(expense, reason, tenantId, userId) {
    if (!expense.approvalRequestId) return;
    try {
      const request = await ApprovalWorkflowService.getApprovalRequestById(expense.approvalRequestId, tenantId);
      if (["Pending", "Escalated"].includes(request.status)) {
        await ApprovalWorkflowService.cancelApprovalRequest(expense.approvalRequestId, { reason }, tenantId, userId);
      }
    } catch {
      // Already resolved/cancelled, or not found — nothing to close.
    }
  }

  /**
   * POST /api/v1/expenses/{expenseId}/approve — records the approval at
   * the next sequential required level (Manager -> Finance -> CFO); only
   * fires `ExpenseApproved` once every required level has signed off.
   * Same permission-gates-who-may-approve-at-all simplification already
   * used for Cash Transfer's own dual authorization (Part 15) — this
   * codebase's RBAC has no per-level role mapping (no org-hierarchy model
   * exists to know who someone's actual manager is). On final approval,
   * also posts the real accrual journal (Part 35) when both GL account
   * codes are configured.
   */
  static async approveExpense(expenseId, data, tenantId, userId, auditContext = {}) {
    const expense = await ExpenseModel.findOne({ _id: expenseId, tenantId });
    if (!expense) throw new Error("Expense not found.");
    if (!isExpenseApprovable(expense.status)) throw new Error(`Expense cannot be approved from status "${expense.status}".`);

    const nextLevel = expense.requiredApprovalLevels[expense.approvals.length];
    if (!nextLevel) throw new Error("All required approval levels have already been recorded.");

    expense.approvals.push({ level: nextLevel, approvedBy: userId || null, approvedAt: new Date(), notes: data?.notes || null });
    expense.updatedBy = userId || null;

    if (expense.approvals.length >= expense.requiredApprovalLevels.length) {
      // "Budget Override" — a Finance/CFO approver knowingly approving an
      // exceeded budget (config expenseBudgetEnforcement === "Warn").
      if (expense.budgetCheck?.exceeded) expense.budgetCheck.overridden = true;

      expense.status = "Approved";
      expense.timeline.push({ event: "ExpenseApproved", description: `${nextLevel} approval recorded — all required levels complete.`, performedBy: userId || null });

      if (expense.budgetCheck?.scopeRef) {
        await ExpenseBudgetModel.updateOne(
          { tenantId, scope: expense.budgetCheck.scope, scopeRef: expense.budgetCheck.scopeRef, period: expense.budgetCheck.period },
          { $inc: { consumedAmount: expense.amount }, $set: { updatedBy: userId || null } }
        );
        // "Budget Reserved" (Part 44) — the real, already-existing
        // consumedAmount increment above IS the reservation; this only adds
        // the matching domain event, never a second reservation mechanism.
        publishEvent("BudgetReserved", { tenantId, expenseId: expense._id.toString(), scope: expense.budgetCheck.scope, scopeRef: expense.budgetCheck.scopeRef, amount: expense.amount, performedBy: userId || null });
      }

      // "Expense Approved -> Accounting Validation -> Journal Generated
      // -> ... -> General Ledger Posted" (Part 35's own diagram/journal
      // example) — real accrual posting, not fabricated. Skipped
      // (returns null) when either account code isn't configured; falls
      // back to the original Part 16 direct posting at Reimbursement.
      const accrualJournalId = await ExpenseService._postAccrualJournal(expense, tenantId, userId);
      if (accrualJournalId) {
        expense.accrual = { journalId: accrualJournalId, postedAt: new Date() };
        expense.timeline.push({ event: "ExpenseAccrualPosted", description: `Accrual journal posted.`, performedBy: userId || "system" });
        publishEvent("ExpensePosted", { tenantId, expenseId: expense._id.toString(), journalId: accrualJournalId.toString(), performedBy: userId || "system" });
      }

      await expense.save();
      await ExpenseService._mirrorDecisionToApprovalRequest(expense, "Approved", data?.notes || null, tenantId, userId);
      await ExpenseService._closeApprovalRequest(expense, "Completed via Expense's own approval flow (Approved).", tenantId, userId);

      await AuditLogModel.create({ action: "finance.expense.approve", module: "Finance", resource: "Expense", resourceId: expense._id.toString(), userId: userId || null, tenantId, details: { level: nextLevel, final: true, accrualPosted: !!accrualJournalId }, ...auditContext });
      publishEvent("ExpenseApproved", { tenantId, expenseId: expense._id.toString(), amount: expense.amount, performedBy: userId || null });
      await ExpenseService._notifyExpenseOwner(expense, { subject: `Expense ${expense.expenseNumber} approved`, content: `Your expense "${expense.description}" (${expense.amount} ${expense.currency}) has been fully approved.` }, tenantId);
    } else {
      expense.timeline.push({ event: "ExpenseLevelApproved", description: `${nextLevel} approval recorded (${expense.approvals.length}/${expense.requiredApprovalLevels.length}).`, performedBy: userId || null });
      await expense.save();
      await ExpenseService._mirrorDecisionToApprovalRequest(expense, "Approved", data?.notes || null, tenantId, userId);

      await AuditLogModel.create({ action: "finance.expense.approve", module: "Finance", resource: "Expense", resourceId: expense._id.toString(), userId: userId || null, tenantId, details: { level: nextLevel, final: false }, ...auditContext });
    }

    return expense.toJSON();
  }

  static async rejectExpense(expenseId, data, tenantId, userId, auditContext = {}) {
    const expense = await ExpenseModel.findOne({ _id: expenseId, tenantId });
    if (!expense) throw new Error("Expense not found.");
    if (!isExpenseRejectable(expense.status)) throw new Error(`Expense cannot be rejected from status "${expense.status}".`);

    expense.status = "Rejected";
    expense.rejectedBy = userId || null;
    expense.rejectedAt = new Date();
    expense.rejectionReason = data?.reason || null;
    expense.updatedBy = userId || null;
    expense.timeline.push({ event: "ExpenseRejected", description: data?.reason || "Expense rejected.", performedBy: userId || null });
    await expense.save();

    await ExpenseService._mirrorDecisionToApprovalRequest(expense, "Rejected", data?.reason || null, tenantId, userId);
    await ExpenseService._closeApprovalRequest(expense, "Completed via Expense's own approval flow (Rejected).", tenantId, userId);

    await AuditLogModel.create({ action: "finance.expense.reject", module: "Finance", resource: "Expense", resourceId: expense._id.toString(), userId: userId || null, tenantId, details: { reason: data?.reason || null }, ...auditContext });
    publishEvent("ExpenseRejected", { tenantId, expenseId: expense._id.toString(), reason: data?.reason || null, performedBy: userId || null });
    await ExpenseService._notifyExpenseOwner(expense, { subject: `Expense ${expense.expenseNumber} rejected`, content: `Your expense "${expense.description}" was rejected.${data?.reason ? ` Reason: ${data.reason}` : ""}` }, tenantId);

    return expense.toJSON();
  }

  /**
   * POST /api/v1/expenses/{expenseId}/return — "Returned" is a named
   * alternative-flow outcome; publishes the real `ExpenseReturned` domain
   * event (Part 44) alongside the pre-existing timeline entry. Sends the
   * claim back to the employee for correction; resubmitting clears prior
   * approvals and re-runs the full policy/budget/tax check.
   */
  static async returnExpense(expenseId, data, tenantId, userId, auditContext = {}) {
    const expense = await ExpenseModel.findOne({ _id: expenseId, tenantId });
    if (!expense) throw new Error("Expense not found.");
    if (!isExpenseReturnable(expense.status)) throw new Error(`Expense cannot be returned from status "${expense.status}".`);

    expense.status = "Returned";
    expense.returnedBy = userId || null;
    expense.returnedAt = new Date();
    expense.returnReason = data?.reason || null;
    expense.updatedBy = userId || null;
    expense.timeline.push({ event: "ExpenseReturned", description: data?.reason || "Expense returned to employee for correction.", performedBy: userId || null });
    await expense.save();

    await ExpenseService._closeApprovalRequest(expense, "Completed via Expense's own approval flow (Returned).", tenantId, userId);

    await AuditLogModel.create({ action: "finance.expense.return", module: "Finance", resource: "Expense", resourceId: expense._id.toString(), userId: userId || null, tenantId, details: { reason: data?.reason || null }, ...auditContext });
    publishEvent("ExpenseReturned", { tenantId, expenseId: expense._id.toString(), employeeId: expense.employeeId.toString(), reason: data?.reason || null, performedBy: userId || null });
    await ExpenseService._notifyExpenseOwner(expense, { subject: `Expense ${expense.expenseNumber} returned for correction`, content: `Your expense "${expense.description}" was returned for correction.${data?.reason ? ` Reason: ${data.reason}` : ""}` }, tenantId);

    return expense.toJSON();
  }

  /**
   * POST /api/v1/expenses/{expenseId}/cancel — Part 35 extends this to an
   * already-Approved (not yet Reimbursed) expense, with real, automatic
   * budget rollback and accrual-journal reversal ("Budget rollback occurs
   * automatically if expense is rejected or cancelled" — the spec's own
   * Budget Integration rule). Draft/Submitted/Under Review/Returned
   * cancellation is unchanged (nothing to roll back — budget is only ever
   * consumed on final approval).
   */
  static async cancelExpense(expenseId, data, tenantId, userId, auditContext = {}) {
    const expense = await ExpenseModel.findOne({ _id: expenseId, tenantId });
    if (!expense) throw new Error("Expense not found.");
    if (!isExpenseCancellable(expense.status)) throw new Error(`Expense cannot be cancelled from status "${expense.status}".`);

    const wasApproved = expense.status === "Approved";

    expense.status = "Cancelled";
    expense.cancelledBy = userId || null;
    expense.cancelledAt = new Date();
    expense.cancellationReason = data?.reason || null;
    expense.updatedBy = userId || null;
    expense.timeline.push({ event: "ExpenseCancelled", description: data?.reason || "Expense cancelled.", performedBy: userId || null });

    let budgetRolledBack = false;
    let accrualReversed = false;

    if (wasApproved) {
      if (expense.budgetCheck?.scopeRef) {
        await ExpenseBudgetModel.updateOne(
          { tenantId, scope: expense.budgetCheck.scope, scopeRef: expense.budgetCheck.scopeRef, period: expense.budgetCheck.period },
          { $inc: { consumedAmount: -expense.amount }, $set: { updatedBy: userId || null } }
        );
        budgetRolledBack = true;
        expense.timeline.push({ event: "ExpenseBudgetRolledBack", description: `Consumed budget for ${expense.budgetCheck.scope} "${expense.budgetCheck.scopeRef}" released.`, performedBy: userId || null });
        // "Budget Released" (Part 44) — the real, already-existing
        // consumedAmount decrement above IS the release; matching domain event.
        publishEvent("BudgetReleased", { tenantId, expenseId: expense._id.toString(), scope: expense.budgetCheck.scope, scopeRef: expense.budgetCheck.scopeRef, amount: expense.amount, performedBy: userId || null });
      }
      if (expense.accrual?.journalId) {
        const reversal = await JournalService.reverseJournal(expense.accrual.journalId, {}, tenantId, userId || "system");
        accrualReversed = true;
        expense.timeline.push({ event: "ExpenseAccrualReversed", description: `Accrual journal reversed (${reversal.journalNumber || reversal._id}).`, performedBy: userId || "system" });
        publishEvent("ExpenseReversed", { tenantId, expenseId: expense._id.toString(), reversalJournalId: (reversal._id || reversal.journalId || "").toString(), performedBy: userId || "system" });
      }
    }

    await expense.save();
    await ExpenseService._closeApprovalRequest(expense, "Completed via Expense's own approval flow (Cancelled).", tenantId, userId);

    await AuditLogModel.create({ action: "finance.expense.cancel", module: "Finance", resource: "Expense", resourceId: expense._id.toString(), userId: userId || null, tenantId, details: { reason: data?.reason || null, budgetRolledBack, accrualReversed }, ...auditContext });
    publishEvent("ExpenseCancelled", { tenantId, expenseId: expense._id.toString(), budgetRolledBack, accrualReversed, performedBy: userId || null });

    return expense.toJSON();
  }

  /**
   * POST /api/v1/expenses/{expenseId}/reimburse — "The reimbursement is
   * the financial event." Reimburses the full gross amount (claimed
   * amount + any recoverable tax — the employee paid that out of pocket
   * too). Dispatches to whichever real primitive actually moves the
   * money: `BankAccountService.applyTransaction` (Bank Transfer),
   * `CashManagementService.applyCashTransaction` (Cash/Petty Cash), or
   * `AccountsPayableService.createPayable` (Accounts Payable — reuses
   * that service's own existing journal-posting logic entirely).
   * "Payroll"/"Digital Wallet" are not implementable — see
   * utils/financeConfig.js reimbursementMethods doc comment.
   */
  static async reimburseExpense(expenseId, data, tenantId, userId, auditContext = {}) {
    const config = getFinanceConfig();
    const { method, bankAccountId = null, cashLocationId = null, vendorId = null } = data;

    if (!config.reimbursementMethods.includes(method)) throw new Error(`Invalid reimbursement method "${method}".`);

    const expense = await ExpenseModel.findOne({ _id: expenseId, tenantId });
    if (!expense) throw new Error("Expense not found.");
    if (!isExpenseReimbursable(expense.status)) throw new Error(`Expense cannot be reimbursed from status "${expense.status}".`);

    await FinancialPeriodService.assertPeriodOpen(tenantId, new Date());

    const reimbursementAmount = roundCurrency(expense.amount + (expense.tax?.taxAmount || 0));

    let targetType = null;
    let targetId = null;
    let journalId = null;

    if (method === "Bank Transfer") {
      if (!bankAccountId) throw new Error("bankAccountId is required for Bank Transfer reimbursement.");
      const bankAccount = await BankAccountModel.findOne({ _id: bankAccountId, tenantId }).lean();
      if (!bankAccount) throw new Error("Bank account not found.");
      journalId = await ExpenseService._postReimbursementJournal(expense, bankAccount.glAccountCode, reimbursementAmount, tenantId, userId);
      const { transaction } = await BankAccountService.applyTransaction(bankAccountId, tenantId, { direction: "Debit", amount: reimbursementAmount, currency: expense.currency, type: "ExpenseReimbursement", sourceType: "Expense", sourceId: expense._id, description: expense.description, performedBy: userId || null });
      targetType = "bank_transaction"; targetId = transaction._id;
    } else if (method === "Cash" || method === "Petty Cash") {
      if (!cashLocationId) throw new Error("cashLocationId is required for Cash/Petty Cash reimbursement.");
      const cashLocation = await CashLocationModel.findOne({ _id: cashLocationId, tenantId }).lean();
      if (!cashLocation) throw new Error("Cash location not found.");
      journalId = await ExpenseService._postReimbursementJournal(expense, cashLocation.glAccountCode, reimbursementAmount, tenantId, userId);
      const { transaction } = await CashManagementService.applyCashTransaction(cashLocationId, tenantId, { direction: "Debit", amount: reimbursementAmount, currency: expense.currency, type: "ExpenseReimbursement", sourceType: "Expense", sourceId: expense._id, description: expense.description, performedBy: userId || null });
      targetType = "cash_transaction"; targetId = transaction._id;
    } else if (method === "Accounts Payable") {
      if (!vendorId) throw new Error("vendorId is required for Accounts Payable reimbursement (the employee must already be set up as a vendor record).");
      const vendor = await VendorModel.findOne({ _id: vendorId, tenantId }).lean();
      if (!vendor) throw new Error("Vendor not found.");
      // When accrual already recognized the expense+tax and credited the
      // payable account, this AP creation must clear THAT payable, not
      // re-debit the expense account (which would double-count it).
      const expenseAccountCode = expense.accrual?.journalId ? config.expenseReimbursementPayableAccountCode : config.expenseReimbursementExpenseAccountCode;
      const payable = await AccountsPayableService.createPayable({
        vendorId, invoiceNumber: expense.expenseNumber, invoiceDate: new Date(), dueDate: new Date(),
        originalAmount: reimbursementAmount, currency: expense.currency, expenseAccountCode
      }, tenantId, userId);
      targetType = "accounts_payable"; targetId = payable._id;
    }

    expense.reimbursement = { method, amount: reimbursementAmount, currency: expense.currency, targetType, targetId, journalId, reimbursedBy: userId || null, reimbursedAt: new Date() };
    expense.status = "Reimbursed";
    expense.updatedBy = userId || null;
    expense.timeline.push({ event: "ExpenseReimbursed", description: `Reimbursed ${reimbursementAmount} ${expense.currency} via ${method}.`, performedBy: userId || null });
    await expense.save();

    await AuditLogModel.create({ action: "finance.expense.reimburse", module: "Finance", resource: "Expense", resourceId: expense._id.toString(), userId: userId || null, tenantId, details: { method, amount: reimbursementAmount, targetType, targetId: targetId ? targetId.toString() : null }, ...auditContext });
    publishEvent("ExpenseReimbursed", { tenantId, expenseId: expense._id.toString(), employeeId: expense.employeeId.toString(), method, amount: reimbursementAmount, performedBy: userId || null });
    await ExpenseService._notifyExpenseOwner(expense, { subject: `Expense ${expense.expenseNumber} reimbursed`, content: `Your expense "${expense.description}" has been reimbursed: ${reimbursementAmount} ${expense.currency} via ${method}.` }, tenantId);

    return expense.toJSON();
  }

  static async _postSimpleJournal(lines, description, expense, tenantId, userId) {
    const journal = await JournalService.createJournal({
      journalType: "Automatic",
      postingDate: new Date(),
      description,
      referenceNumber: expense.expenseNumber,
      currency: expense.currency,
      lines
    }, tenantId, userId || "system");
    await JournalService.approveJournal(journal._id, tenantId, userId || "system");
    const posted = await JournalService.postJournal(journal._id, tenantId, userId || "system");
    const postedJournalId = posted?._id || journal._id;
    // "Ledger Posting Completed" (Part 44) — the one real point every
    // Expense-generated journal (accrual and reimbursement/clearing alike)
    // actually posts through; a single publish site rather than one per
    // caller.
    publishEvent("LedgerPostingCompleted", { tenantId, expenseId: expense._id.toString(), journalId: postedJournalId.toString(), description, performedBy: userId || "system" });
    return postedJournalId;
  }

  /**
   * Accrual-style GL recognition at Approval (Part 35) — "Dr Travel
   * Expense Account, Dr Recoverable VAT, Cr Employee Reimbursement
   * Payable" (the refactor spec's own Journal Posting Example). Real,
   * skipped (returns null) unless both
   * expenseReimbursementExpenseAccountCode and
   * expenseReimbursementPayableAccountCode are configured for this
   * tenant — the same "skip until configured" discipline as every other
   * optional account code in this module. When tax exists but no separate
   * recoverable-tax account is configured, tax is folded into the single
   * expense debit line rather than fabricating a tax account that
   * doesn't exist.
   */
  static async _postAccrualJournal(expense, tenantId, userId) {
    const config = getFinanceConfig();
    if (!config.expenseReimbursementExpenseAccountCode || !config.expenseReimbursementPayableAccountCode) return null;

    const taxAmount = expense.tax?.taxAmount || 0;
    const grossAmount = roundCurrency(expense.amount + taxAmount);

    const lines = [];
    if (taxAmount > 0 && config.expenseRecoverableTaxAccountCode) {
      lines.push({ accountCode: config.expenseReimbursementExpenseAccountCode, debit: expense.amount });
      lines.push({ accountCode: config.expenseRecoverableTaxAccountCode, debit: taxAmount });
    } else {
      lines.push({ accountCode: config.expenseReimbursementExpenseAccountCode, debit: grossAmount });
    }
    lines.push({ accountCode: config.expenseReimbursementPayableAccountCode, credit: grossAmount });

    return ExpenseService._postSimpleJournal(lines, `Expense accrual ${expense.expenseNumber}: ${expense.description}`, expense, tenantId, userId);
  }

  /**
   * Once an accrual journal exists, this posts the CLEARING entry (Dr
   * Employee Reimbursement Payable, Cr Bank/Cash/AP) rather than a second
   * expense recognition. Falls back to the original Part 16 direct
   * Dr-Expense/Cr-Cash entry when no accrual was posted for this expense
   * (account codes weren't configured at Approval time).
   */
  static async _postReimbursementJournal(expense, creditAccountCode, reimbursementAmount, tenantId, userId) {
    const config = getFinanceConfig();

    if (expense.accrual?.journalId) {
      if (!config.expenseReimbursementPayableAccountCode || !creditAccountCode) return null;
      return ExpenseService._postSimpleJournal([
        { accountCode: config.expenseReimbursementPayableAccountCode, debit: reimbursementAmount },
        { accountCode: creditAccountCode, credit: reimbursementAmount }
      ], `Expense reimbursement settlement ${expense.expenseNumber}: ${expense.description}`, expense, tenantId, userId);
    }

    if (!config.expenseReimbursementExpenseAccountCode || !creditAccountCode) return null;
    return ExpenseService._postSimpleJournal([
      { accountCode: config.expenseReimbursementExpenseAccountCode, debit: reimbursementAmount },
      { accountCode: creditAccountCode, credit: reimbursementAmount }
    ], `Expense reimbursement ${expense.expenseNumber}: ${expense.description}`, expense, tenantId, userId);
  }

  /**
   * POST /api/v1/expenses/{expenseId}/close — the named `ExpenseClosed`
   * event, Reimbursed only.
   */
  static async closeExpense(expenseId, tenantId, userId, auditContext = {}) {
    const expense = await ExpenseModel.findOne({ _id: expenseId, tenantId });
    if (!expense) throw new Error("Expense not found.");
    if (!isExpenseCloseable(expense.status)) throw new Error(`Expense cannot be closed from status "${expense.status}".`);

    expense.status = "Closed";
    expense.closedBy = userId || null;
    expense.closedAt = new Date();
    expense.updatedBy = userId || null;
    expense.timeline.push({ event: "ExpenseClosed", description: "Expense closed.", performedBy: userId || null });
    await expense.save();

    await AuditLogModel.create({ action: "finance.expense.close", module: "Finance", resource: "Expense", resourceId: expense._id.toString(), userId: userId || null, tenantId, details: {}, ...auditContext });
    publishEvent("ExpenseClosed", { tenantId, expenseId: expense._id.toString(), performedBy: userId || null });
    await ExpenseService._notifyExpenseOwner(expense, { subject: `Expense ${expense.expenseNumber} closed`, content: `Your expense "${expense.description}" has been closed.`, priority: "Low" }, tenantId);

    return expense.toJSON();
  }

  // ---- Expense Budgets ----

  static async createExpenseBudget(data, tenantId, userId) {
    const { scope, scopeRef, period, currency, allocatedAmount } = data;
    if (!["Department", "Project", "CostCenter"].includes(scope)) throw new Error('scope must be "Department", "Project", or "CostCenter".');
    if (!scopeRef || !period || !currency || allocatedAmount === undefined) throw new Error("scopeRef, period, currency, and allocatedAmount are required.");
    if (!/^\d{4}$/.test(period) && !/^\d{4}-\d{2}$/.test(period)) throw new Error('period must be "YYYY" or "YYYY-MM".');

    if (scope === "Department") {
      const department = await DepartmentModel.findOne({ _id: scopeRef, tenantId }).lean();
      if (!department) throw new Error("Department not found.");
    }

    const existing = await ExpenseBudgetModel.findOne({ tenantId, scope, scopeRef, period }).lean();
    if (existing) throw new Error(`A budget for ${scope} "${scopeRef}" in period "${period}" already exists.`);

    const budget = await ExpenseBudgetModel.create({ tenantId, scope, scopeRef, period, currency, allocatedAmount: roundCurrency(allocatedAmount), consumedAmount: 0, createdBy: userId || null, updatedBy: userId || null });

    await AuditLogModel.create({ action: "finance.expense.create_budget", module: "Finance", resource: "ExpenseBudget", resourceId: budget._id.toString(), userId: userId || null, tenantId, details: { scope, scopeRef, period, allocatedAmount: budget.allocatedAmount } });

    return budget.toJSON();
  }

  static async listExpenseBudgets(query, tenantId) {
    const filter = { tenantId };
    if (query.scope) filter.scope = query.scope;
    if (query.scopeRef) filter.scopeRef = query.scopeRef;
    if (query.period) filter.period = query.period;
    return ExpenseBudgetModel.find(filter).sort({ createdAt: -1 }).lean();
  }

  static async getExpenseBudgetById(budgetId, tenantId) {
    const budget = await ExpenseBudgetModel.findOne({ _id: budgetId, tenantId }).lean();
    if (!budget) throw new Error("Expense budget not found.");
    return budget;
  }
}

export default ExpenseService;
