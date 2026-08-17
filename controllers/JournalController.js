import multer from "multer";
import JournalService from "../services/JournalService.js";
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
  if (message.includes("already been") || message.includes("Version conflict")) return 409;
  if (message.includes("not found")) return 404;
  if (message.includes("required") || message.includes("cannot") || message.includes("out of balance") || message.includes("exceeds") || message.includes("does not") || message.includes("Invalid")) return 400;
  return 500;
};

// Journal attachment upload — memoryStorage, the same real pattern
// ExpenseController.uploadReceiptFile already uses (Part 35).
export const uploadJournalAttachmentFile = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: getFinanceConfig().journalAttachmentMaxFileSizeBytes }
}).single("file");

// Journal import upload — same memoryStorage pattern, a separate multer
// instance only because its own max-file-size config differs.
export const uploadJournalImportFile = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: getFinanceConfig().journalImportMaxFileSizeBytes }
}).single("file");

export const listJournals = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.journal.read", "finance.read")) return sendError(res, 403, "Permission denied.", requestId);

    const result = await JournalService.listJournals(req.query, scope.tenantId);
    return sendSuccess(res, 200, "Journals retrieved successfully.", result, requestId);
  } catch (error) {
    console.error("listJournals error:", error);
    return sendError(res, 500, error.message || "Failed to retrieve journals.", requestId);
  }
};

export const getJournal = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.journal.read", "finance.read")) return sendError(res, 403, "Permission denied.", requestId);

    const journal = await JournalService.getJournalById(req.params.journalId, scope.tenantId);
    return sendSuccess(res, 200, "Journal retrieved successfully.", journal, requestId);
  } catch (error) {
    console.error("getJournal error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to retrieve journal.", requestId);
  }
};

export const createJournal = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.journal.create")) return sendError(res, 403, "Permission denied.", requestId);
    const userId = req.auth?.userId || req.auth?.id || null;

    const journal = await JournalService.createJournal(req.body, scope.tenantId, userId);
    return sendSuccess(res, 201, "Journal created successfully.", journal, requestId);
  } catch (error) {
    console.error("createJournal error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to create journal.", requestId);
  }
};

export const updateJournal = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.journal.update")) return sendError(res, 403, "Permission denied.", requestId);
    const userId = req.auth?.userId || req.auth?.id || null;

    const journal = await JournalService.updateJournal(req.params.journalId, req.body, scope.tenantId, userId);
    return sendSuccess(res, 200, "Journal updated successfully.", journal, requestId);
  } catch (error) {
    console.error("updateJournal error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to update journal.", requestId);
  }
};

export const approveJournal = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.journal.approve")) return sendError(res, 403, "Permission denied.", requestId);
    const userId = req.auth?.userId || req.auth?.id || null;

    const journal = await JournalService.approveJournal(req.params.journalId, scope.tenantId, userId);
    return sendSuccess(res, 200, "Journal approved successfully.", journal, requestId);
  } catch (error) {
    console.error("approveJournal error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to approve journal.", requestId);
  }
};

export const rejectJournal = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.journal.approve")) return sendError(res, 403, "Permission denied.", requestId);
    const userId = req.auth?.userId || req.auth?.id || null;

    const journal = await JournalService.rejectJournal(req.params.journalId, req.body, scope.tenantId, userId);
    return sendSuccess(res, 200, "Journal rejected.", journal, requestId);
  } catch (error) {
    console.error("rejectJournal error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to reject journal.", requestId);
  }
};

export const cancelJournal = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.journal.update")) return sendError(res, 403, "Permission denied.", requestId);
    const userId = req.auth?.userId || req.auth?.id || null;

    const journal = await JournalService.cancelJournal(req.params.journalId, scope.tenantId, userId);
    return sendSuccess(res, 200, "Journal cancelled.", journal, requestId);
  } catch (error) {
    console.error("cancelJournal error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to cancel journal.", requestId);
  }
};

// ---- File 2, Journal Platform Part 4 (Part 41) ----

export const archiveJournal = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.journal.update")) return sendError(res, 403, "Permission denied.", requestId);
    const userId = req.auth?.userId || req.auth?.id || null;

    const journal = await JournalService.archiveJournal(req.params.journalId, scope.tenantId, userId);
    return sendSuccess(res, 200, "Journal archived successfully.", journal, requestId);
  } catch (error) {
    console.error("archiveJournal error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to archive journal.", requestId);
  }
};

export const restoreJournal = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.journal.update")) return sendError(res, 403, "Permission denied.", requestId);
    const userId = req.auth?.userId || req.auth?.id || null;

    const journal = await JournalService.restoreJournal(req.params.journalId, scope.tenantId, userId);
    return sendSuccess(res, 200, "Journal restored successfully.", journal, requestId);
  } catch (error) {
    console.error("restoreJournal error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to restore journal.", requestId);
  }
};

export const postJournal = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.journal.post")) return sendError(res, 403, "Permission denied.", requestId);
    const userId = req.auth?.userId || req.auth?.id || null;

    const journal = await JournalService.postJournal(req.params.journalId, scope.tenantId, userId);
    return sendSuccess(res, 200, "Journal posted to the General Ledger successfully.", journal, requestId);
  } catch (error) {
    console.error("postJournal error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to post journal.", requestId);
  }
};

export const reverseJournal = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.journal.reverse")) return sendError(res, 403, "Permission denied.", requestId);
    const userId = req.auth?.userId || req.auth?.id || null;

    const result = await JournalService.reverseJournal(req.params.journalId, req.body, scope.tenantId, userId);
    return sendSuccess(res, 201, "Journal reversed successfully.", result, requestId);
  } catch (error) {
    console.error("reverseJournal error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to reverse journal.", requestId);
  }
};

// ---- File 2, Journal Platform Part 2 (Part 39) ----

export const correctJournal = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.journal.correct")) return sendError(res, 403, "Permission denied.", requestId);
    const userId = req.auth?.userId || req.auth?.id || null;

    const result = await JournalService.correctJournal(req.params.journalId, req.body, scope.tenantId, userId);
    return sendSuccess(res, 201, "Journal corrected successfully.", result, requestId);
  } catch (error) {
    console.error("correctJournal error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to correct journal.", requestId);
  }
};

export const getJournalHistory = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.journal.read", "finance.read")) return sendError(res, 403, "Permission denied.", requestId);

    const history = await JournalService.getJournalHistory(req.params.journalId, scope.tenantId);
    return sendSuccess(res, 200, "Journal history retrieved successfully.", history, requestId);
  } catch (error) {
    console.error("getJournalHistory error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to retrieve journal history.", requestId);
  }
};

// ---- Journal Templates ----

export const listJournalTemplates = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.journal.read", "finance.read")) return sendError(res, 403, "Permission denied.", requestId);

    const templates = await JournalService.listJournalTemplates(req.query, scope.tenantId);
    return sendSuccess(res, 200, "Journal templates retrieved successfully.", templates, requestId);
  } catch (error) {
    console.error("listJournalTemplates error:", error);
    return sendError(res, 500, error.message || "Failed to retrieve journal templates.", requestId);
  }
};

export const getJournalTemplate = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.journal.read", "finance.read")) return sendError(res, 403, "Permission denied.", requestId);

    const template = await JournalService.getJournalTemplateById(req.params.templateId, scope.tenantId);
    return sendSuccess(res, 200, "Journal template retrieved successfully.", template, requestId);
  } catch (error) {
    console.error("getJournalTemplate error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to retrieve journal template.", requestId);
  }
};

export const createJournalTemplate = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.journal.manage")) return sendError(res, 403, "Permission denied.", requestId);
    const userId = req.auth?.userId || req.auth?.id || null;

    const template = await JournalService.createJournalTemplate(req.body, scope.tenantId, userId);
    return sendSuccess(res, 201, "Journal template created successfully.", template, requestId);
  } catch (error) {
    console.error("createJournalTemplate error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to create journal template.", requestId);
  }
};

export const applyJournalTemplate = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.journal.create")) return sendError(res, 403, "Permission denied.", requestId);
    const userId = req.auth?.userId || req.auth?.id || null;

    const journal = await JournalService.applyJournalTemplate(req.params.templateId, req.body, scope.tenantId, userId);
    return sendSuccess(res, 201, "Journal template applied successfully.", journal, requestId);
  } catch (error) {
    console.error("applyJournalTemplate error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to apply journal template.", requestId);
  }
};

// ---- Recurring Journals ----

export const createRecurringJournal = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.journal.manage")) return sendError(res, 403, "Permission denied.", requestId);
    const userId = req.auth?.userId || req.auth?.id || null;

    const recurring = await JournalService.createRecurringJournal(req.body, scope.tenantId, userId);
    return sendSuccess(res, 201, "Recurring journal created successfully.", recurring, requestId);
  } catch (error) {
    console.error("createRecurringJournal error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to create recurring journal.", requestId);
  }
};

export const listRecurringJournals = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.journal.read", "finance.read")) return sendError(res, 403, "Permission denied.", requestId);

    const recurring = await JournalService.listRecurringJournals(req.query, scope.tenantId);
    return sendSuccess(res, 200, "Recurring journals retrieved successfully.", recurring, requestId);
  } catch (error) {
    console.error("listRecurringJournals error:", error);
    return sendError(res, 500, error.message || "Failed to retrieve recurring journals.", requestId);
  }
};

export const getRecurringJournal = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.journal.read", "finance.read")) return sendError(res, 403, "Permission denied.", requestId);

    const recurring = await JournalService.getRecurringJournalById(req.params.recurringJournalId, scope.tenantId);
    return sendSuccess(res, 200, "Recurring journal retrieved successfully.", recurring, requestId);
  } catch (error) {
    console.error("getRecurringJournal error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to retrieve recurring journal.", requestId);
  }
};

export const pauseRecurringJournal = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.journal.manage")) return sendError(res, 403, "Permission denied.", requestId);
    const userId = req.auth?.userId || req.auth?.id || null;

    const recurring = await JournalService.setRecurringJournalStatus(req.params.recurringJournalId, "Paused", scope.tenantId, userId);
    return sendSuccess(res, 200, "Recurring journal paused.", recurring, requestId);
  } catch (error) {
    console.error("pauseRecurringJournal error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to pause recurring journal.", requestId);
  }
};

export const resumeRecurringJournal = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.journal.manage")) return sendError(res, 403, "Permission denied.", requestId);
    const userId = req.auth?.userId || req.auth?.id || null;

    const recurring = await JournalService.setRecurringJournalStatus(req.params.recurringJournalId, "Active", scope.tenantId, userId);
    return sendSuccess(res, 200, "Recurring journal resumed.", recurring, requestId);
  } catch (error) {
    console.error("resumeRecurringJournal error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to resume recurring journal.", requestId);
  }
};

export const cancelRecurringJournal = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.journal.manage")) return sendError(res, 403, "Permission denied.", requestId);
    const userId = req.auth?.userId || req.auth?.id || null;

    const recurring = await JournalService.setRecurringJournalStatus(req.params.recurringJournalId, "Cancelled", scope.tenantId, userId);
    return sendSuccess(res, 200, "Recurring journal cancelled.", recurring, requestId);
  } catch (error) {
    console.error("cancelRecurringJournal error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to cancel recurring journal.", requestId);
  }
};

// ---- Journal Batches ----

export const createJournalBatch = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.journal.manage")) return sendError(res, 403, "Permission denied.", requestId);
    const userId = req.auth?.userId || req.auth?.id || null;

    const batch = await JournalService.createJournalBatch(req.body, scope.tenantId, userId);
    return sendSuccess(res, 201, "Journal batch processed.", batch, requestId);
  } catch (error) {
    console.error("createJournalBatch error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to process journal batch.", requestId);
  }
};

export const listJournalBatches = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.journal.read", "finance.read")) return sendError(res, 403, "Permission denied.", requestId);

    const batches = await JournalService.listJournalBatches(req.query, scope.tenantId);
    return sendSuccess(res, 200, "Journal batches retrieved successfully.", batches, requestId);
  } catch (error) {
    console.error("listJournalBatches error:", error);
    return sendError(res, 500, error.message || "Failed to retrieve journal batches.", requestId);
  }
};

export const getJournalBatch = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.journal.read", "finance.read")) return sendError(res, 403, "Permission denied.", requestId);

    const batch = await JournalService.getJournalBatchById(req.params.batchId, scope.tenantId);
    return sendSuccess(res, 200, "Journal batch retrieved successfully.", batch, requestId);
  } catch (error) {
    console.error("getJournalBatch error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to retrieve journal batch.", requestId);
  }
};

// ---- File 2, Journal Platform Part 3 (Part 40) ----

export const createRevenueRecognitionJournal = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.journal.create")) return sendError(res, 403, "Permission denied.", requestId);
    const userId = req.auth?.userId || req.auth?.id || null;

    const journal = await JournalService.createRevenueRecognitionJournal(req.body, scope.tenantId, userId);
    return sendSuccess(res, 201, "Revenue recognition journal created successfully.", journal, requestId);
  } catch (error) {
    console.error("createRevenueRecognitionJournal error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to create revenue recognition journal.", requestId);
  }
};

export const searchJournals = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.journal.read", "finance.read")) return sendError(res, 403, "Permission denied.", requestId);

    const result = await JournalService.searchJournals(req.query, scope.tenantId, req.auth?.permissions || []);
    return sendSuccess(res, 200, "Journal search completed successfully.", result, requestId);
  } catch (error) {
    console.error("searchJournals error:", error);
    return sendError(res, 500, error.message || "Failed to search journals.", requestId);
  }
};

export const getJournalStatistics = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.journal.read", "finance.read")) return sendError(res, 403, "Permission denied.", requestId);

    const stats = await JournalService.getJournalStatistics(scope.tenantId);
    return sendSuccess(res, 200, "Journal statistics retrieved successfully.", stats, requestId);
  } catch (error) {
    console.error("getJournalStatistics error:", error);
    return sendError(res, 500, error.message || "Failed to retrieve journal statistics.", requestId);
  }
};

export const addJournalAttachment = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.journal.create")) return sendError(res, 403, "Permission denied.", requestId);
    const userId = req.auth?.userId || req.auth?.id || null;

    if (!req.file) return sendError(res, 400, "An attachment file is required (multipart field \"file\").", requestId);

    const attachment = await JournalService.addJournalAttachment(req.params.journalId, req.file, scope.tenantId, userId);
    return sendSuccess(res, 201, "Journal attachment added successfully.", attachment, requestId);
  } catch (error) {
    console.error("addJournalAttachment error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to add journal attachment.", requestId);
  }
};

export const previewJournalImport = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.journal.manage")) return sendError(res, 403, "Permission denied.", requestId);

    if (!req.file) return sendError(res, 400, "An import file is required (multipart field \"file\").", requestId);
    const mapping = req.body.mapping ? JSON.parse(req.body.mapping) : {};

    const preview = await JournalService.previewJournalImport(req.file.buffer, req.body.format, mapping, scope.tenantId);
    return sendSuccess(res, 200, "Journal import preview generated successfully.", preview, requestId);
  } catch (error) {
    console.error("previewJournalImport error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to preview journal import.", requestId);
  }
};

export const importJournals = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.journal.manage")) return sendError(res, 403, "Permission denied.", requestId);
    const userId = req.auth?.userId || req.auth?.id || null;

    if (!req.file) return sendError(res, 400, "An import file is required (multipart field \"file\").", requestId);
    const mapping = req.body.mapping ? JSON.parse(req.body.mapping) : {};

    const result = await JournalService.importJournals(req.file.buffer, req.body.format, mapping, scope.tenantId, userId);
    return sendSuccess(res, 201, "Journals imported successfully.", result, requestId);
  } catch (error) {
    console.error("importJournals error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to import journals.", requestId);
  }
};
