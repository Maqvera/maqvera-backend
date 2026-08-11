import multer from "multer";
import BankReconciliationService from "../services/BankReconciliationService.js";
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
  if (message.includes("required") || message.includes("cannot") || message.includes("Cannot") || message.includes("Invalid") || message.includes("exceeds") || message.includes("must be") || message.includes("mismatch") || message.includes("could not be determined")) return 400;
  return 500;
};

// Statement file upload — memoryStorage so the buffer can be handed
// straight to the format parser (services/reconciliationParsers/) and
// archived via storeDocumentPdf, same multer pattern already used for
// AI Knowledge document uploads (controllers/AIKnowledgeController.js). No
// mimetype fileFilter — bank export tools frequently mislabel MIME types
// for MT940/OFX/CSV; format validity is checked honestly by the parser
// itself, not guessed from a header a bank's own export tool got wrong.
export const uploadStatementFile = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: getFinanceConfig().reconciliationImportMaxFileSizeBytes }
}).single("file");

export const importStatement = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.reconciliation.create")) return sendError(res, 403, "Permission denied.", requestId);
    const userId = req.auth?.userId || req.auth?.id || null;

    if (!req.file) return sendError(res, 400, "A statement file is required (multipart field \"file\").", requestId);

    const reconciliation = await BankReconciliationService.importStatement(req.body, req.file.buffer, scope.tenantId, userId);
    return sendSuccess(res, 201, "Bank statement imported successfully.", reconciliation, requestId);
  } catch (error) {
    console.error("importStatement error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to import bank statement.", requestId);
  }
};

export const listReconciliations = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.reconciliation.read", "finance.read")) return sendError(res, 403, "Permission denied.", requestId);

    const result = await BankReconciliationService.listReconciliations(req.query, scope.tenantId);
    return sendSuccess(res, 200, "Reconciliations retrieved successfully.", result, requestId);
  } catch (error) {
    console.error("listReconciliations error:", error);
    return sendError(res, 500, error.message || "Failed to retrieve reconciliations.", requestId);
  }
};

export const getReconciliation = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.reconciliation.read", "finance.read")) return sendError(res, 403, "Permission denied.", requestId);

    const reconciliation = await BankReconciliationService.getReconciliationById(req.params.reconciliationId, scope.tenantId);
    return sendSuccess(res, 200, "Reconciliation retrieved successfully.", reconciliation, requestId);
  } catch (error) {
    console.error("getReconciliation error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to retrieve reconciliation.", requestId);
  }
};

export const runAutoMatch = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.reconciliation.match")) return sendError(res, 403, "Permission denied.", requestId);
    const userId = req.auth?.userId || req.auth?.id || null;

    const reconciliation = await BankReconciliationService.runAutoMatch(req.params.reconciliationId, scope.tenantId, userId);
    return sendSuccess(res, 200, "Auto-matching completed successfully.", reconciliation, requestId);
  } catch (error) {
    console.error("runAutoMatch error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to run auto-matching.", requestId);
  }
};

export const matchTransaction = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.reconciliation.match")) return sendError(res, 403, "Permission denied.", requestId);
    const userId = req.auth?.userId || req.auth?.id || null;

    const result = await BankReconciliationService.matchTransaction(req.params.reconciliationId, req.body, scope.tenantId, userId);
    return sendSuccess(res, 200, "Transaction matched successfully.", result, requestId);
  } catch (error) {
    console.error("matchTransaction error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to match transaction.", requestId);
  }
};

export const unmatchTransaction = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.reconciliation.match")) return sendError(res, 403, "Permission denied.", requestId);
    const userId = req.auth?.userId || req.auth?.id || null;

    const result = await BankReconciliationService.unmatchTransaction(req.params.reconciliationId, req.body, scope.tenantId, userId);
    return sendSuccess(res, 200, "Transaction unmatched successfully.", result, requestId);
  } catch (error) {
    console.error("unmatchTransaction error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to unmatch transaction.", requestId);
  }
};

export const listStatementTransactions = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.reconciliation.read", "finance.read")) return sendError(res, 403, "Permission denied.", requestId);

    const items = await BankReconciliationService.listStatementTransactions(req.params.reconciliationId, req.query, scope.tenantId);
    return sendSuccess(res, 200, "Statement transactions retrieved successfully.", { items }, requestId);
  } catch (error) {
    console.error("listStatementTransactions error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to retrieve statement transactions.", requestId);
  }
};

export const listExceptions = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.reconciliation.read", "finance.read")) return sendError(res, 403, "Permission denied.", requestId);

    const items = await BankReconciliationService.listExceptions(req.params.reconciliationId, req.query, scope.tenantId);
    return sendSuccess(res, 200, "Exceptions retrieved successfully.", { items }, requestId);
  } catch (error) {
    console.error("listExceptions error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to retrieve exceptions.", requestId);
  }
};

export const resolveException = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.reconciliation.match")) return sendError(res, 403, "Permission denied.", requestId);
    const userId = req.auth?.userId || req.auth?.id || null;

    const exception = await BankReconciliationService.resolveException(req.params.exceptionId, req.body, scope.tenantId, userId);
    return sendSuccess(res, 200, "Exception resolved successfully.", exception, requestId);
  } catch (error) {
    console.error("resolveException error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to resolve exception.", requestId);
  }
};

export const createAdjustment = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.reconciliation.manage")) return sendError(res, 403, "Permission denied.", requestId);
    const userId = req.auth?.userId || req.auth?.id || null;

    const reconciliation = await BankReconciliationService.createAdjustment(req.params.reconciliationId, req.body, scope.tenantId, userId);
    return sendSuccess(res, 201, "Adjustment created successfully.", reconciliation, requestId);
  } catch (error) {
    console.error("createAdjustment error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to create adjustment.", requestId);
  }
};

export const approveReconciliation = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.reconciliation.approve")) return sendError(res, 403, "Permission denied.", requestId);
    const userId = req.auth?.userId || req.auth?.id || null;

    const reconciliation = await BankReconciliationService.approveReconciliation(req.params.reconciliationId, scope.tenantId, userId);
    return sendSuccess(res, 200, "Reconciliation approved successfully.", reconciliation, requestId);
  } catch (error) {
    console.error("approveReconciliation error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to approve reconciliation.", requestId);
  }
};

export const completeReconciliation = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.reconciliation.approve")) return sendError(res, 403, "Permission denied.", requestId);
    const userId = req.auth?.userId || req.auth?.id || null;

    const reconciliation = await BankReconciliationService.completeReconciliation(req.params.reconciliationId, scope.tenantId, userId);
    return sendSuccess(res, 200, "Reconciliation completed successfully.", reconciliation, requestId);
  } catch (error) {
    console.error("completeReconciliation error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to complete reconciliation.", requestId);
  }
};

export const rejectReconciliation = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.reconciliation.approve")) return sendError(res, 403, "Permission denied.", requestId);
    const userId = req.auth?.userId || req.auth?.id || null;

    const reconciliation = await BankReconciliationService.rejectReconciliation(req.params.reconciliationId, req.body, scope.tenantId, userId);
    return sendSuccess(res, 200, "Reconciliation rejected successfully.", reconciliation, requestId);
  } catch (error) {
    console.error("rejectReconciliation error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to reject reconciliation.", requestId);
  }
};

export const reopenReconciliation = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.reconciliation.manage")) return sendError(res, 403, "Permission denied.", requestId);
    const userId = req.auth?.userId || req.auth?.id || null;

    const reconciliation = await BankReconciliationService.reopenReconciliation(req.params.reconciliationId, scope.tenantId, userId);
    return sendSuccess(res, 200, "Reconciliation reopened successfully.", reconciliation, requestId);
  } catch (error) {
    console.error("reopenReconciliation error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to reopen reconciliation.", requestId);
  }
};

export const archiveReconciliation = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.reconciliation.manage")) return sendError(res, 403, "Permission denied.", requestId);
    const userId = req.auth?.userId || req.auth?.id || null;

    const reconciliation = await BankReconciliationService.archiveReconciliation(req.params.reconciliationId, scope.tenantId, userId);
    return sendSuccess(res, 200, "Reconciliation archived successfully.", reconciliation, requestId);
  } catch (error) {
    console.error("archiveReconciliation error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to archive reconciliation.", requestId);
  }
};

export const suggestAiMatches = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.reconciliation.match")) return sendError(res, 403, "Permission denied.", requestId);
    const userId = req.auth?.userId || req.auth?.id || null;

    const result = await BankReconciliationService.suggestAiMatches(req.params.reconciliationId, scope.tenantId, userId);
    return sendSuccess(res, 200, "AI match suggestions generated.", result, requestId);
  } catch (error) {
    console.error("suggestAiMatches error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to generate AI match suggestions.", requestId);
  }
};

export const acceptAiSuggestion = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.reconciliation.match")) return sendError(res, 403, "Permission denied.", requestId);
    const userId = req.auth?.userId || req.auth?.id || null;

    const result = await BankReconciliationService.acceptAiSuggestion(req.params.reconciliationId, req.body, scope.tenantId, userId);
    return sendSuccess(res, 200, "AI suggestion accepted and matched.", result, requestId);
  } catch (error) {
    console.error("acceptAiSuggestion error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to accept AI suggestion.", requestId);
  }
};

export const getReport = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.reconciliation.read", "finance.read")) return sendError(res, 403, "Permission denied.", requestId);

    const report = await BankReconciliationService.generateReport(req.params.reconciliationId, scope.tenantId);
    return sendSuccess(res, 200, "Reconciliation report generated successfully.", report, requestId);
  } catch (error) {
    console.error("getReport error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to generate reconciliation report.", requestId);
  }
};

// Raw file download — deliberately not the sendSuccess JSON envelope
// (there is no existing precedent for streaming generated file content in
// this codebase; ReceiptController's own "download" redirects to a stored
// URL instead, which doesn't apply here since this CSV is generated
// on-demand, not pre-stored).
export const exportReportCsv = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.reconciliation.read", "finance.read")) return sendError(res, 403, "Permission denied.", requestId);

    const { filename, csv } = await BankReconciliationService.exportReportCsv(req.params.reconciliationId, scope.tenantId);
    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    return res.status(200).send(csv);
  } catch (error) {
    console.error("exportReportCsv error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to export reconciliation report.", requestId);
  }
};
