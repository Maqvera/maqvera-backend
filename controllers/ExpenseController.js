import multer from "multer";
import ExpenseService from "../services/ExpenseService.js";
import { sendSuccess, sendError } from "../utils/apiResponse.js";
import { createRequestId } from "../utils/authTokens.js";
import { getAccessScope } from "../utils/accessScope.js";
import { getFinanceConfig } from "../utils/financeConfig.js";

const hasPermission = (req, ...keys) => {
  const permissions = req.auth?.permissions || [];
  return permissions.includes("admin") || keys.some((key) => permissions.includes(key));
};

const statusFromError = (error) => {
  const message = error.message || "";
  if (message.includes("already exists")) return 409;
  if (message.includes("not found")) return 404;
  if (message.includes("required") || message.includes("cannot") || message.includes("Cannot") || message.includes("Invalid") || message.includes("exceeds") || message.includes("must") || message.includes("violation") || message.includes("No exchange rate") || message.includes("No active tax rule") || message.includes("do not reconcile")) return 400;
  return 500;
};

// "Audit Information... Created From, IP Address, Device, Correlation
// ID" (Part 35) — real request context, plumbed through to
// AuditLogModel.create via ExpenseService's own optional `auditContext`
// parameter. `req.ip` / `user-agent` are real Express/HTTP values, never
// fabricated; `requestId` is the same real per-request id every response
// already echoes (utils/apiResponse.js).
const auditContextFrom = (req, requestId) => ({
  requestId,
  ipAddress: req.ip || req.socket?.remoteAddress || null,
  device: req.headers["user-agent"] || null
});

// Receipt upload — memoryStorage, same pattern as Bank Reconciliation's own
// uploadStatementFile (controllers/BankReconciliationController.js).
export const uploadReceiptFile = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: getFinanceConfig().expenseReceiptMaxFileSizeBytes }
}).single("file");

// ---- Expenses ----

export const listExpenses = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.expense.read", "finance.read")) return sendError(res, 403, "Permission denied.", requestId);

    const result = await ExpenseService.listExpenses(req.query, scope.tenantId);
    return sendSuccess(res, 200, "Expenses retrieved successfully.", result, requestId);
  } catch (error) {
    console.error("listExpenses error:", error);
    return sendError(res, 500, error.message || "Failed to retrieve expenses.", requestId);
  }
};

export const getExpense = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.expense.read", "finance.read")) return sendError(res, 403, "Permission denied.", requestId);

    const expense = await ExpenseService.getExpenseById(req.params.expenseId, scope.tenantId);
    return sendSuccess(res, 200, "Expense retrieved successfully.", expense, requestId);
  } catch (error) {
    console.error("getExpense error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to retrieve expense.", requestId);
  }
};

export const createExpense = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.expense.create")) return sendError(res, 403, "Permission denied.", requestId);
    const userId = req.auth?.userId || req.auth?.id || null;

    const expense = await ExpenseService.createExpense(req.body, scope.tenantId, userId, auditContextFrom(req, requestId));
    return sendSuccess(res, 201, "Expense created successfully.", expense, requestId);
  } catch (error) {
    console.error("createExpense error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to create expense.", requestId);
  }
};

export const updateExpense = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.expense.create")) return sendError(res, 403, "Permission denied.", requestId);
    const userId = req.auth?.userId || req.auth?.id || null;

    const expense = await ExpenseService.updateExpense(req.params.expenseId, req.body, scope.tenantId, userId, auditContextFrom(req, requestId));
    return sendSuccess(res, 200, "Expense updated successfully.", expense, requestId);
  } catch (error) {
    console.error("updateExpense error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to update expense.", requestId);
  }
};

export const uploadReceipt = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.expense.create")) return sendError(res, 403, "Permission denied.", requestId);
    const userId = req.auth?.userId || req.auth?.id || null;

    if (!req.file) return sendError(res, 400, "A receipt file is required (multipart field \"file\").", requestId);

    const expense = await ExpenseService.uploadReceipt(req.params.expenseId, req.file, scope.tenantId, userId, auditContextFrom(req, requestId));
    return sendSuccess(res, 201, "Receipt uploaded successfully.", expense, requestId);
  } catch (error) {
    console.error("uploadReceipt error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to upload receipt.", requestId);
  }
};

export const verifyExpenseReceipt = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.expense.approve")) return sendError(res, 403, "Permission denied.", requestId);
    const userId = req.auth?.userId || req.auth?.id || null;

    const expense = await ExpenseService.verifyReceipt(req.params.expenseId, req.params.attachmentId, req.body, scope.tenantId, userId, auditContextFrom(req, requestId));
    return sendSuccess(res, 200, "Receipt verification updated successfully.", expense, requestId);
  } catch (error) {
    console.error("verifyReceipt error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to update receipt verification.", requestId);
  }
};

export const submitExpense = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.expense.create")) return sendError(res, 403, "Permission denied.", requestId);
    const userId = req.auth?.userId || req.auth?.id || null;

    const expense = await ExpenseService.submitExpense(req.params.expenseId, scope.tenantId, userId, auditContextFrom(req, requestId));
    return sendSuccess(res, 200, "Expense submitted successfully.", expense, requestId);
  } catch (error) {
    console.error("submitExpense error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to submit expense.", requestId);
  }
};

export const approveExpense = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.expense.approve")) return sendError(res, 403, "Permission denied.", requestId);
    const userId = req.auth?.userId || req.auth?.id || null;

    const expense = await ExpenseService.approveExpense(req.params.expenseId, req.body, scope.tenantId, userId, auditContextFrom(req, requestId));
    return sendSuccess(res, 200, "Expense approval recorded successfully.", expense, requestId);
  } catch (error) {
    console.error("approveExpense error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to approve expense.", requestId);
  }
};

export const rejectExpense = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.expense.approve")) return sendError(res, 403, "Permission denied.", requestId);
    const userId = req.auth?.userId || req.auth?.id || null;

    const expense = await ExpenseService.rejectExpense(req.params.expenseId, req.body, scope.tenantId, userId, auditContextFrom(req, requestId));
    return sendSuccess(res, 200, "Expense rejected successfully.", expense, requestId);
  } catch (error) {
    console.error("rejectExpense error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to reject expense.", requestId);
  }
};

export const returnExpense = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.expense.approve")) return sendError(res, 403, "Permission denied.", requestId);
    const userId = req.auth?.userId || req.auth?.id || null;

    const expense = await ExpenseService.returnExpense(req.params.expenseId, req.body, scope.tenantId, userId, auditContextFrom(req, requestId));
    return sendSuccess(res, 200, "Expense returned successfully.", expense, requestId);
  } catch (error) {
    console.error("returnExpense error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to return expense.", requestId);
  }
};

export const cancelExpense = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.expense.create")) return sendError(res, 403, "Permission denied.", requestId);
    const userId = req.auth?.userId || req.auth?.id || null;

    const expense = await ExpenseService.cancelExpense(req.params.expenseId, req.body, scope.tenantId, userId, auditContextFrom(req, requestId));
    return sendSuccess(res, 200, "Expense cancelled successfully.", expense, requestId);
  } catch (error) {
    console.error("cancelExpense error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to cancel expense.", requestId);
  }
};

export const reimburseExpense = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.expense.manage")) return sendError(res, 403, "Permission denied.", requestId);
    const userId = req.auth?.userId || req.auth?.id || null;

    const expense = await ExpenseService.reimburseExpense(req.params.expenseId, req.body, scope.tenantId, userId, auditContextFrom(req, requestId));
    return sendSuccess(res, 200, "Expense reimbursed successfully.", expense, requestId);
  } catch (error) {
    console.error("reimburseExpense error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to reimburse expense.", requestId);
  }
};

export const closeExpense = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.expense.manage")) return sendError(res, 403, "Permission denied.", requestId);
    const userId = req.auth?.userId || req.auth?.id || null;

    const expense = await ExpenseService.closeExpense(req.params.expenseId, scope.tenantId, userId, auditContextFrom(req, requestId));
    return sendSuccess(res, 200, "Expense closed successfully.", expense, requestId);
  } catch (error) {
    console.error("closeExpense error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to close expense.", requestId);
  }
};

// ---- Expense Budgets ----

export const listExpenseBudgets = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.expense.read", "finance.read")) return sendError(res, 403, "Permission denied.", requestId);

    const items = await ExpenseService.listExpenseBudgets(req.query, scope.tenantId);
    return sendSuccess(res, 200, "Expense budgets retrieved successfully.", { items }, requestId);
  } catch (error) {
    console.error("listExpenseBudgets error:", error);
    return sendError(res, 500, error.message || "Failed to retrieve expense budgets.", requestId);
  }
};

export const getExpenseBudget = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.expense.read", "finance.read")) return sendError(res, 403, "Permission denied.", requestId);

    const budget = await ExpenseService.getExpenseBudgetById(req.params.budgetId, scope.tenantId);
    return sendSuccess(res, 200, "Expense budget retrieved successfully.", budget, requestId);
  } catch (error) {
    console.error("getExpenseBudget error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to retrieve expense budget.", requestId);
  }
};

export const createExpenseBudget = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.expense.manage")) return sendError(res, 403, "Permission denied.", requestId);
    const userId = req.auth?.userId || req.auth?.id || null;

    const budget = await ExpenseService.createExpenseBudget(req.body, scope.tenantId, userId);
    return sendSuccess(res, 201, "Expense budget created successfully.", budget, requestId);
  } catch (error) {
    console.error("createExpenseBudget error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to create expense budget.", requestId);
  }
};
