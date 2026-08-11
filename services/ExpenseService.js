import crypto from "crypto";
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
import JournalService from "./JournalService.js";
import FinancialPeriodService from "./FinancialPeriodService.js";
import FinanceSequenceModel from "../models/FinanceSequenceModel.js";
import AuditLogModel from "../models/AuditLogmodel.js";
import ExpenseOcrService from "./ExpenseOcrService.js";
import ApprovalWorkflowService from "./ApprovalWorkflowService.js";
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
const CANCELLABLE_STATUSES = new Set(["Draft", "Submitted", "Under Review", "Returned"]);
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
  static async createExpense(data, tenantId, userId) {
    const config = getFinanceConfig();
    const { employeeId, department = null, projectId = null, costCenter = null, category, currency, expenseDate, description, paymentMethod = null, amount = null, perDiem = null, mileage = null, corporateCard = null } = data;

    if (!employeeId || !category || !currency || !expenseDate || !description) {
      throw new Error("employeeId, category, currency, expenseDate, and description are required.");
    }
    if (!config.expenseCategories.includes(category)) throw new Error(`Invalid category "${category}".`);
    if (!config.supportedCurrencies.includes(currency)) throw new Error(`Unsupported currency "${currency}".`);
    if (paymentMethod && !config.expensePaymentMethods.includes(paymentMethod)) throw new Error(`Invalid paymentMethod "${paymentMethod}".`);

    const employee = await UserModel.findById(employeeId).lean();
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

    const expenseNumber = await ExpenseService._generateExpenseNumber(tenantId);

    const expense = await ExpenseModel.create({
      tenantId, expenseNumber, employeeId, employeeName: employee.username, department, projectId, costCenter,
      category, amount: resolvedAmount, currency, expenseDate: new Date(expenseDate), description, paymentMethod,
      corporateCard: corporateCard || undefined,
      perDiem: perDiemData, mileage: mileageData,
      status: config.defaultExpenseStatus,
      timeline: [{ event: "ExpenseCreated", description: `Draft expense ${expenseNumber} (${category}) created for ${employee.username}.`, performedBy: userId || null }],
      createdBy: userId || null,
      updatedBy: userId || null
    });

    await AuditLogModel.create({ action: "finance.expense.create", module: "Finance", resource: "Expense", resourceId: expense._id.toString(), userId: userId || null, tenantId, details: { expenseNumber, category, amount: resolvedAmount } });
    publishEvent("ExpenseCreated", { tenantId, expenseId: expense._id.toString(), employeeId: employeeId.toString(), amount: resolvedAmount, currency, performedBy: userId || null });

    return expense.toJSON();
  }

  static async listExpenses(query, tenantId) {
    const config = getFinanceConfig();
    const { employeeId, department, category, status, project } = query;
    const filter = { tenantId };
    if (employeeId) filter.employeeId = employeeId;
    if (department) filter.department = department;
    if (category) filter.category = category;
    if (status) filter.status = status;
    if (project) filter.projectId = project;
    if (query.dateFrom || query.dateTo) {
      filter.expenseDate = {};
      if (query.dateFrom) filter.expenseDate.$gte = new Date(query.dateFrom);
      if (query.dateTo) filter.expenseDate.$lte = new Date(query.dateTo);
    }

    const page = Math.max(parseInt(query.page, 10) || 1, 1);
    const pageSize = Math.min(Math.max(parseInt(query.pageSize, 10) || config.defaultPageSize, 1), config.maxPageSize);
    const skip = (page - 1) * pageSize;

    let sortSpec = { expenseDate: -1 };
    if (query.sort) {
      const direction = query.sort.startsWith("-") ? -1 : 1;
      const field = query.sort.replace(/^-/, "");
      sortSpec = { [field]: direction };
    }

    const [items, total] = await Promise.all([
      ExpenseModel.find(filter).sort(sortSpec).skip(skip).limit(pageSize).lean(),
      ExpenseModel.countDocuments(filter)
    ]);

    return { items, pagination: { total, page, pageSize, totalPages: Math.ceil(total / pageSize) } };
  }

  static async getExpenseById(expenseId, tenantId) {
    const expense = await ExpenseModel.findOne({ _id: expenseId, tenantId }).lean();
    if (!expense) throw new Error("Expense not found.");

    const auditSummary = await AuditLogModel.find({ tenantId, resource: "Expense", resourceId: expense._id.toString() }).sort({ createdAt: -1 }).limit(20).lean();
    return { ...expense, auditSummary };
  }

  /**
   * PATCH /api/v1/expenses/{expenseId} — gap-fill, Draft/Returned only.
   */
  static async updateExpense(expenseId, data, tenantId, userId) {
    const config = getFinanceConfig();
    const expense = await ExpenseModel.findOne({ _id: expenseId, tenantId });
    if (!expense) throw new Error("Expense not found.");
    if (!isExpenseEditable(expense.status)) throw new Error(`Expense cannot be edited from status "${expense.status}".`);

    const { category, amount, description, expenseDate, department, projectId, costCenter, paymentMethod } = data;
    if (category !== undefined) {
      if (!config.expenseCategories.includes(category)) throw new Error(`Invalid category "${category}".`);
      expense.category = category;
    }
    if (amount !== undefined) expense.amount = roundCurrency(amount);
    if (description !== undefined) expense.description = description;
    if (expenseDate !== undefined) expense.expenseDate = new Date(expenseDate);
    if (department !== undefined) expense.department = department;
    if (projectId !== undefined) expense.projectId = projectId;
    if (costCenter !== undefined) expense.costCenter = costCenter;
    if (paymentMethod !== undefined) {
      if (paymentMethod && !config.expensePaymentMethods.includes(paymentMethod)) throw new Error(`Invalid paymentMethod "${paymentMethod}".`);
      expense.paymentMethod = paymentMethod;
    }

    expense.updatedBy = userId || null;
    expense.timeline.push({ event: "ExpenseUpdated", description: "Expense details updated.", performedBy: userId || null });
    await expense.save();

    await AuditLogModel.create({ action: "finance.expense.update", module: "Finance", resource: "Expense", resourceId: expense._id.toString(), userId: userId || null, tenantId, details: {} });

    return expense.toJSON();
  }

  /**
   * POST /api/v1/expenses/{expenseId}/receipts — "Receipt Management...
   * Image Upload, PDF Upload, OCR Extraction, Duplicate Detection,
   * Receipt Verification, Long-term Archive." Duplicate detection is a
   * real SHA-256 checksum match against this same employee's other
   * receipts — not a fuzzy OCR-based guess.
   */
  static async uploadReceipt(expenseId, file, tenantId, userId) {
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

    const attachment = {
      filename: file.originalname || "receipt", url: stored.url, storageKey: stored.storageKey, storageProvider: stored.storageProvider,
      mimeType: file.mimetype, checksum, ocr,
      verification: { status: duplicate ? "Duplicate" : "Pending", verifiedBy: null, verifiedAt: null, notes: duplicate ? "Matches the checksum of another receipt already on file for this employee." : null },
      uploadedBy: userId || null, uploadedAt: new Date()
    };
    expense.attachments.push(attachment);
    expense.timeline.push({ event: "ReceiptUploaded", description: `Receipt "${attachment.filename}" uploaded${duplicate ? " (possible duplicate)" : ""}.`, performedBy: userId || null });
    await expense.save();

    await AuditLogModel.create({ action: "finance.expense.upload_receipt", module: "Finance", resource: "Expense", resourceId: expense._id.toString(), userId: userId || null, tenantId, details: { filename: attachment.filename, ocrStatus: ocr.status, duplicate: !!duplicate } });
    if (ocr.status === "Completed") publishEvent("OCRCompleted", { tenantId, expenseId: expense._id.toString(), extractedAmount: ocr.extractedAmount, extractedVendor: ocr.extractedVendor, performedBy: userId || null });

    return expense.toJSON();
  }

  /**
   * POST /api/v1/expenses/{expenseId}/receipts/{attachmentId}/verify —
   * gap-fill for the named `ReceiptVerified` event.
   */
  static async verifyReceipt(expenseId, attachmentId, data, tenantId, userId) {
    const { status, notes = null } = data;
    if (!["Verified", "Duplicate", "Rejected"].includes(status)) throw new Error('status must be "Verified", "Duplicate", or "Rejected".');

    const expense = await ExpenseModel.findOne({ _id: expenseId, tenantId });
    if (!expense) throw new Error("Expense not found.");
    const attachment = expense.attachments.id(attachmentId);
    if (!attachment) throw new Error("Attachment not found.");

    attachment.verification = { status, verifiedBy: userId || null, verifiedAt: new Date(), notes };
    expense.timeline.push({ event: "ReceiptVerificationUpdated", description: `Receipt "${attachment.filename}" marked ${status}.`, performedBy: userId || null });
    await expense.save();

    await AuditLogModel.create({ action: "finance.expense.verify_receipt", module: "Finance", resource: "Expense", resourceId: expense._id.toString(), userId: userId || null, tenantId, details: { attachmentId: attachmentId.toString(), status } });
    if (status === "Verified") publishEvent("ReceiptVerified", { tenantId, expenseId: expense._id.toString(), attachmentId: attachmentId.toString(), performedBy: userId || null });

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
   * Validate Policy -> Validate Budget -> Approval Workflow (levels
   * computed) -> Publish ExpenseSubmitted.
   */
  static async submitExpense(expenseId, tenantId, userId) {
    const config = getFinanceConfig();
    const expense = await ExpenseModel.findOne({ _id: expenseId, tenantId });
    if (!expense) throw new Error("Expense not found.");
    if (!isExpenseSubmittable(expense.status)) throw new Error(`Expense cannot be submitted from status "${expense.status}".`);

    await FinancialPeriodService.assertPeriodOpen(tenantId, expense.expenseDate);

    const hasReceipt = expense.attachments.length > 0;
    const violations = checkPolicyViolations({ category: expense.category, amount: expense.amount, hasReceipt, config });
    if (violations.length > 0) throw new Error(`Policy violation(s): ${violations.join(", ")}.`);
    expense.policyViolations = [];

    const matchingBudget = await ExpenseService._findMatchingBudget(tenantId, { department: expense.department, projectId: expense.projectId, costCenter: expense.costCenter }, expense.expenseDate);
    if (matchingBudget) {
      const projectedTotal = roundCurrency(matchingBudget.consumedAmount + expense.amount);
      const exceeded = projectedTotal > matchingBudget.allocatedAmount;
      expense.budgetCheck = { scope: matchingBudget.scope, scopeRef: matchingBudget.scopeRef, period: matchingBudget.period, allocatedAmount: matchingBudget.allocatedAmount, consumedAmountBefore: matchingBudget.consumedAmount, exceeded, checkedAt: new Date() };
      if (exceeded) {
        if (config.expenseBudgetEnforcement === "Block") {
          throw new Error(`Budget exceeded for ${matchingBudget.scope} "${matchingBudget.scopeRef}" (${matchingBudget.period}): allocated ${matchingBudget.allocatedAmount}, projected ${projectedTotal}.`);
        }
        publishEvent("BudgetExceeded", { tenantId, expenseId: expense._id.toString(), scope: matchingBudget.scope, scopeRef: matchingBudget.scopeRef, allocatedAmount: matchingBudget.allocatedAmount, projectedTotal, performedBy: userId || null });
      }
    } else {
      expense.budgetCheck = { scope: null, scopeRef: null, period: null, allocatedAmount: null, consumedAmountBefore: null, exceeded: false, checkedAt: new Date() };
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
    expense.submittedBy = userId || null;
    expense.submittedAt = new Date();
    expense.status = "Under Review";
    expense.updatedBy = userId || null;
    expense.timeline.push({ event: "ExpenseSubmitted", description: `Submitted for approval (${expense.requiredApprovalLevels.join(" -> ")}).`, performedBy: userId || null });
    await expense.save();

    await AuditLogModel.create({ action: "finance.expense.submit", module: "Finance", resource: "Expense", resourceId: expense._id.toString(), userId: userId || null, tenantId, details: { requiredApprovalLevels: expense.requiredApprovalLevels, budgetExceeded: expense.budgetCheck.exceeded } });
    publishEvent("ExpenseSubmitted", { tenantId, expenseId: expense._id.toString(), employeeId: expense.employeeId.toString(), amount: expense.amount, requiredApprovalLevels: expense.requiredApprovalLevels, performedBy: userId || null });

    return expense.toJSON();
  }

  /**
   * POST /api/v1/expenses/{expenseId}/approve — records the approval at
   * the next sequential required level (Manager -> Finance -> CFO); only
   * fires `ExpenseApproved` once every required level has signed off.
   * Same permission-gates-who-may-approve-at-all simplification already
   * used for Cash Transfer's own dual authorization (Part 15) — this
   * codebase's RBAC has no per-level role mapping (no org-hierarchy model
   * exists to know who someone's actual manager is).
   */
  static async approveExpense(expenseId, data, tenantId, userId) {
    const expense = await ExpenseModel.findOne({ _id: expenseId, tenantId });
    if (!expense) throw new Error("Expense not found.");
    if (!isExpenseApprovable(expense.status)) throw new Error(`Expense cannot be approved from status "${expense.status}".`);

    const nextLevel = expense.requiredApprovalLevels[expense.approvals.length];
    if (!nextLevel) throw new Error("All required approval levels have already been recorded.");

    expense.approvals.push({ level: nextLevel, approvedBy: userId || null, approvedAt: new Date(), notes: data?.notes || null });
    expense.updatedBy = userId || null;

    if (expense.approvals.length >= expense.requiredApprovalLevels.length) {
      expense.status = "Approved";
      expense.timeline.push({ event: "ExpenseApproved", description: `${nextLevel} approval recorded — all required levels complete.`, performedBy: userId || null });
      await expense.save();

      if (expense.budgetCheck?.scopeRef) {
        await ExpenseBudgetModel.updateOne(
          { tenantId, scope: expense.budgetCheck.scope, scopeRef: expense.budgetCheck.scopeRef, period: expense.budgetCheck.period },
          { $inc: { consumedAmount: expense.amount }, $set: { updatedBy: userId || null } }
        );
      }

      await AuditLogModel.create({ action: "finance.expense.approve", module: "Finance", resource: "Expense", resourceId: expense._id.toString(), userId: userId || null, tenantId, details: { level: nextLevel, final: true } });
      publishEvent("ExpenseApproved", { tenantId, expenseId: expense._id.toString(), amount: expense.amount, performedBy: userId || null });
    } else {
      expense.timeline.push({ event: "ExpenseLevelApproved", description: `${nextLevel} approval recorded (${expense.approvals.length}/${expense.requiredApprovalLevels.length}).`, performedBy: userId || null });
      await expense.save();

      await AuditLogModel.create({ action: "finance.expense.approve", module: "Finance", resource: "Expense", resourceId: expense._id.toString(), userId: userId || null, tenantId, details: { level: nextLevel, final: false } });
    }

    return expense.toJSON();
  }

  static async rejectExpense(expenseId, data, tenantId, userId) {
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

    await AuditLogModel.create({ action: "finance.expense.reject", module: "Finance", resource: "Expense", resourceId: expense._id.toString(), userId: userId || null, tenantId, details: { reason: data?.reason || null } });
    publishEvent("ExpenseRejected", { tenantId, expenseId: expense._id.toString(), reason: data?.reason || null, performedBy: userId || null });

    return expense.toJSON();
  }

  /**
   * POST /api/v1/expenses/{expenseId}/return — gap-fill: "Returned" is a
   * named alternative-flow outcome with no domain event of its own. Sends
   * the claim back to the employee for correction; resubmitting clears
   * prior approvals and re-runs the full policy/budget check.
   */
  static async returnExpense(expenseId, data, tenantId, userId) {
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

    await AuditLogModel.create({ action: "finance.expense.return", module: "Finance", resource: "Expense", resourceId: expense._id.toString(), userId: userId || null, tenantId, details: { reason: data?.reason || null } });

    return expense.toJSON();
  }

  static async cancelExpense(expenseId, data, tenantId, userId) {
    const expense = await ExpenseModel.findOne({ _id: expenseId, tenantId });
    if (!expense) throw new Error("Expense not found.");
    if (!isExpenseCancellable(expense.status)) throw new Error(`Expense cannot be cancelled from status "${expense.status}".`);

    expense.status = "Cancelled";
    expense.cancelledBy = userId || null;
    expense.cancelledAt = new Date();
    expense.cancellationReason = data?.reason || null;
    expense.updatedBy = userId || null;
    expense.timeline.push({ event: "ExpenseCancelled", description: data?.reason || "Expense cancelled.", performedBy: userId || null });
    await expense.save();

    await AuditLogModel.create({ action: "finance.expense.cancel", module: "Finance", resource: "Expense", resourceId: expense._id.toString(), userId: userId || null, tenantId, details: { reason: data?.reason || null } });

    return expense.toJSON();
  }

  /**
   * POST /api/v1/expenses/{expenseId}/reimburse — "The reimbursement is
   * the financial event." Dispatches to whichever real primitive actually
   * moves the money: `BankAccountService.applyTransaction` (Bank
   * Transfer), `CashManagementService.applyCashTransaction` (Cash/Petty
   * Cash), or `AccountsPayableService.createPayable` (Accounts Payable —
   * reuses that service's own existing journal-posting logic entirely).
   * "Payroll"/"Wallet Credit" are not implementable — see
   * utils/financeConfig.js reimbursementMethods doc comment.
   */
  static async reimburseExpense(expenseId, data, tenantId, userId) {
    const config = getFinanceConfig();
    const { method, bankAccountId = null, cashLocationId = null, vendorId = null } = data;

    if (!config.reimbursementMethods.includes(method)) throw new Error(`Invalid reimbursement method "${method}".`);

    const expense = await ExpenseModel.findOne({ _id: expenseId, tenantId });
    if (!expense) throw new Error("Expense not found.");
    if (!isExpenseReimbursable(expense.status)) throw new Error(`Expense cannot be reimbursed from status "${expense.status}".`);

    await FinancialPeriodService.assertPeriodOpen(tenantId, new Date());

    let targetType = null;
    let targetId = null;
    let journalId = null;

    if (method === "Bank Transfer") {
      if (!bankAccountId) throw new Error("bankAccountId is required for Bank Transfer reimbursement.");
      const bankAccount = await BankAccountModel.findOne({ _id: bankAccountId, tenantId }).lean();
      if (!bankAccount) throw new Error("Bank account not found.");
      journalId = await ExpenseService._postReimbursementJournal(expense, bankAccount.glAccountCode, tenantId, userId);
      const { transaction } = await BankAccountService.applyTransaction(bankAccountId, tenantId, { direction: "Debit", amount: expense.amount, currency: expense.currency, type: "ExpenseReimbursement", sourceType: "Expense", sourceId: expense._id, description: expense.description, performedBy: userId || null });
      targetType = "bank_transaction"; targetId = transaction._id;
    } else if (method === "Cash" || method === "Petty Cash") {
      if (!cashLocationId) throw new Error("cashLocationId is required for Cash/Petty Cash reimbursement.");
      const cashLocation = await CashLocationModel.findOne({ _id: cashLocationId, tenantId }).lean();
      if (!cashLocation) throw new Error("Cash location not found.");
      journalId = await ExpenseService._postReimbursementJournal(expense, cashLocation.glAccountCode, tenantId, userId);
      const { transaction } = await CashManagementService.applyCashTransaction(cashLocationId, tenantId, { direction: "Debit", amount: expense.amount, currency: expense.currency, type: "ExpenseReimbursement", sourceType: "Expense", sourceId: expense._id, description: expense.description, performedBy: userId || null });
      targetType = "cash_transaction"; targetId = transaction._id;
    } else if (method === "Accounts Payable") {
      if (!vendorId) throw new Error("vendorId is required for Accounts Payable reimbursement (the employee must already be set up as a vendor record).");
      const vendor = await VendorModel.findOne({ _id: vendorId, tenantId }).lean();
      if (!vendor) throw new Error("Vendor not found.");
      const payable = await AccountsPayableService.createPayable({
        vendorId, invoiceNumber: expense.expenseNumber, invoiceDate: new Date(), dueDate: new Date(),
        originalAmount: expense.amount, currency: expense.currency, expenseAccountCode: config.expenseReimbursementExpenseAccountCode
      }, tenantId, userId);
      targetType = "accounts_payable"; targetId = payable._id;
    }

    expense.reimbursement = { method, amount: expense.amount, currency: expense.currency, targetType, targetId, journalId, reimbursedBy: userId || null, reimbursedAt: new Date() };
    expense.status = "Reimbursed";
    expense.updatedBy = userId || null;
    expense.timeline.push({ event: "ExpenseReimbursed", description: `Reimbursed ${expense.amount} ${expense.currency} via ${method}.`, performedBy: userId || null });
    await expense.save();

    await AuditLogModel.create({ action: "finance.expense.reimburse", module: "Finance", resource: "Expense", resourceId: expense._id.toString(), userId: userId || null, tenantId, details: { method, amount: expense.amount, targetType, targetId: targetId ? targetId.toString() : null } });
    publishEvent("ExpenseReimbursed", { tenantId, expenseId: expense._id.toString(), employeeId: expense.employeeId.toString(), method, amount: expense.amount, performedBy: userId || null });

    return expense.toJSON();
  }

  static async _postReimbursementJournal(expense, creditAccountCode, tenantId, userId) {
    const config = getFinanceConfig();
    if (!config.expenseReimbursementExpenseAccountCode || !creditAccountCode) return null;
    const journal = await JournalService.createJournal({
      journalType: "Automatic",
      postingDate: new Date(),
      description: `Expense reimbursement ${expense.expenseNumber}: ${expense.description}`,
      referenceNumber: expense.expenseNumber,
      currency: expense.currency,
      lines: [
        { accountCode: config.expenseReimbursementExpenseAccountCode, debit: expense.amount },
        { accountCode: creditAccountCode, credit: expense.amount }
      ]
    }, tenantId, userId || "system");
    await JournalService.approveJournal(journal._id, tenantId, userId || "system");
    const posted = await JournalService.postJournal(journal._id, tenantId, userId || "system");
    return posted?._id || journal._id;
  }

  /**
   * POST /api/v1/expenses/{expenseId}/close — the named `ExpenseClosed`
   * event, Reimbursed only.
   */
  static async closeExpense(expenseId, tenantId, userId) {
    const expense = await ExpenseModel.findOne({ _id: expenseId, tenantId });
    if (!expense) throw new Error("Expense not found.");
    if (!isExpenseCloseable(expense.status)) throw new Error(`Expense cannot be closed from status "${expense.status}".`);

    expense.status = "Closed";
    expense.closedBy = userId || null;
    expense.closedAt = new Date();
    expense.updatedBy = userId || null;
    expense.timeline.push({ event: "ExpenseClosed", description: "Expense closed.", performedBy: userId || null });
    await expense.save();

    await AuditLogModel.create({ action: "finance.expense.close", module: "Finance", resource: "Expense", resourceId: expense._id.toString(), userId: userId || null, tenantId, details: {} });
    publishEvent("ExpenseClosed", { tenantId, expenseId: expense._id.toString(), performedBy: userId || null });

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
