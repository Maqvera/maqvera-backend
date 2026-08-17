import multer from "multer";
import CustomerCollectionService from "../services/CustomerCollectionService.js";
import CustomerCreditService from "../services/CustomerCreditService.js";
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
  if (message.includes("required") || message.includes("cannot") || message.includes("Cannot") || message.includes("Invalid") || message.includes("exceeds") || message.includes("must be") || message.includes("mismatch") || message.includes("expired") || message.includes("no remaining balance") || message.includes("no outstanding balance")) return 400;
  return 500;
};

// File 6 Part 5 — memoryStorage-multer, same pattern as ExpenseController's
// own uploadReceiptFile.
export const uploadCollectionAttachmentFile = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: getFinanceConfig().customerCollectionAttachmentMaxFileSizeBytes }
}).single("file");

// ---- Collection Requests ----

export const createCollectionRequest = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.customercollection.create")) return sendError(res, 403, "Permission denied.", requestId);
    const userId = req.auth?.userId || req.auth?.id || null;
    // "Correlation-ID... Supports safe retries." Purely a caller-supplied
    // trace id, distinct from the Idempotency-Key (handled generically by
    // middleware/idempotency.js on the route) — never used for tenant
    // identity or access control.
    const correlationId = req.header("Correlation-ID") || null;

    const collection = await CustomerCollectionService.createCollectionRequest(req.body, scope.tenantId, userId, correlationId);
    return sendSuccess(res, 201, "Customer collection request created successfully.", collection, requestId);
  } catch (error) {
    console.error("createCollectionRequest error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to create customer collection request.", requestId);
  }
};

// ---- Payment Allocation Engine ----

export const allocatePayment = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.customercollection.manage")) return sendError(res, 403, "Permission denied.", requestId);
    const userId = req.auth?.userId || req.auth?.id || null;

    const result = await CustomerCollectionService.allocatePaymentAcrossInvoices(req.params.paymentId, req.body, scope.tenantId, userId);
    return sendSuccess(res, 200, "Payment allocated successfully.", result, requestId);
  } catch (error) {
    console.error("allocatePayment error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to allocate payment.", requestId);
  }
};

// ---- Customer Credit Balance Management ----

export const listCustomerCredits = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.customercollection.read", "finance.read")) return sendError(res, 403, "Permission denied.", requestId);

    const result = await CustomerCreditService.listCredits(req.query, scope.tenantId);
    return sendSuccess(res, 200, "Customer credits retrieved successfully.", result, requestId);
  } catch (error) {
    console.error("listCustomerCredits error:", error);
    return sendError(res, 500, error.message || "Failed to retrieve customer credits.", requestId);
  }
};

// ---- Customer Credit Risk Scoring ----

export const getCustomerRiskScore = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.customercollection.read", "finance.read")) return sendError(res, 403, "Permission denied.", requestId);

    const result = await CustomerCollectionService.getCustomerRiskScore(req.params.customerId, scope.tenantId);
    return sendSuccess(res, 200, "Customer risk score computed successfully.", result, requestId);
  } catch (error) {
    console.error("getCustomerRiskScore error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to compute customer risk score.", requestId);
  }
};

export const listCollections = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.customercollection.read", "finance.read")) return sendError(res, 403, "Permission denied.", requestId);

    const result = await CustomerCollectionService.listCollections(req.query, scope.tenantId);
    return sendSuccess(res, 200, "Customer collections retrieved successfully.", result, requestId);
  } catch (error) {
    console.error("listCollections error:", error);
    return sendError(res, 500, error.message || "Failed to retrieve customer collections.", requestId);
  }
};

export const getCollectionAnalytics = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.customercollection.read", "finance.read")) return sendError(res, 403, "Permission denied.", requestId);

    const result = await CustomerCollectionService.getCollectionAnalytics(scope.tenantId);
    return sendSuccess(res, 200, "Collection analytics generated successfully.", result, requestId);
  } catch (error) {
    console.error("getCollectionAnalytics error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to generate collection analytics.", requestId);
  }
};

export const getCollection = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.customercollection.read", "finance.read")) return sendError(res, 403, "Permission denied.", requestId);

    const collection = await CustomerCollectionService.getCollectionById(req.params.collectionId, scope.tenantId);
    return sendSuccess(res, 200, "Customer collection retrieved successfully.", collection, requestId);
  } catch (error) {
    console.error("getCollection error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to retrieve customer collection.", requestId);
  }
};

export const collectPayment = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.customercollection.manage")) return sendError(res, 403, "Permission denied.", requestId);
    const userId = req.auth?.userId || req.auth?.id || null;
    const correlationId = req.header("Correlation-ID") || null;

    const collection = await CustomerCollectionService.collectPayment(req.params.collectionId, req.body, scope.tenantId, userId, correlationId);
    return sendSuccess(res, collection.paymentStatus === "Failed" ? 402 : 200, "Payment collection processed.", collection, requestId);
  } catch (error) {
    console.error("collectPayment error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to process payment collection.", requestId);
  }
};

/**
 * POST /api/v1/customer-payments/{collectionId}/capture — Part 18 Part 3.
 * Completes a payment a prior `collect` call left "Authorized" under a
 * Manual/Authorize Only/Delayed Capture mode.
 */
export const captureCollectionPayment = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.customercollection.manage")) return sendError(res, 403, "Permission denied.", requestId);
    const userId = req.auth?.userId || req.auth?.id || null;
    const correlationId = req.header("Correlation-ID") || null;

    const collection = await CustomerCollectionService.captureAuthorizedPayment(req.params.collectionId, req.body, scope.tenantId, userId, correlationId);
    return sendSuccess(res, collection.paymentStatus === "Failed" ? 402 : 200, "Payment capture processed.", collection, requestId);
  } catch (error) {
    console.error("captureCollectionPayment error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to process payment capture.", requestId);
  }
};

export const disputeCollection = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.customercollection.manage")) return sendError(res, 403, "Permission denied.", requestId);
    const userId = req.auth?.userId || req.auth?.id || null;

    const collection = await CustomerCollectionService.disputeCollection(req.params.collectionId, req.body, scope.tenantId, userId);
    return sendSuccess(res, 200, "Customer collection disputed successfully.", collection, requestId);
  } catch (error) {
    console.error("disputeCollection error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to dispute customer collection.", requestId);
  }
};

export const writeOffCollection = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.customercollection.approve")) return sendError(res, 403, "Permission denied.", requestId);
    const userId = req.auth?.userId || req.auth?.id || null;

    const result = await CustomerCollectionService.writeOffCollection(req.params.collectionId, req.body, scope.tenantId, userId);
    return sendSuccess(res, 200, "Customer collection written off successfully.", result, requestId);
  } catch (error) {
    console.error("writeOffCollection error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to write off customer collection.", requestId);
  }
};

export const cancelCollection = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.customercollection.manage")) return sendError(res, 403, "Permission denied.", requestId);
    const userId = req.auth?.userId || req.auth?.id || null;

    const collection = await CustomerCollectionService.cancelCollection(req.params.collectionId, req.body, scope.tenantId, userId);
    return sendSuccess(res, 200, "Customer collection cancelled successfully.", collection, requestId);
  } catch (error) {
    console.error("cancelCollection error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to cancel customer collection.", requestId);
  }
};

export const closeCollection = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.customercollection.manage")) return sendError(res, 403, "Permission denied.", requestId);
    const userId = req.auth?.userId || req.auth?.id || null;

    const collection = await CustomerCollectionService.closeCollection(req.params.collectionId, scope.tenantId, userId);
    return sendSuccess(res, 200, "Customer collection closed successfully.", collection, requestId);
  } catch (error) {
    console.error("closeCollection error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to close customer collection.", requestId);
  }
};

// ---- Installment Plans ----

export const createInstallmentPlan = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.customercollection.manage")) return sendError(res, 403, "Permission denied.", requestId);
    const userId = req.auth?.userId || req.auth?.id || null;

    const collection = await CustomerCollectionService.createInstallmentPlan(req.params.collectionId, req.body, scope.tenantId, userId);
    return sendSuccess(res, 201, "Installment plan created successfully.", collection, requestId);
  } catch (error) {
    console.error("createInstallmentPlan error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to create installment plan.", requestId);
  }
};

export const rescheduleInstallment = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.customercollection.manage")) return sendError(res, 403, "Permission denied.", requestId);
    const userId = req.auth?.userId || req.auth?.id || null;

    const collection = await CustomerCollectionService.rescheduleInstallment(req.params.collectionId, parseInt(req.params.installmentNumber, 10), req.body, scope.tenantId, userId);
    return sendSuccess(res, 200, "Installment rescheduled successfully.", collection, requestId);
  } catch (error) {
    console.error("rescheduleInstallment error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to reschedule installment.", requestId);
  }
};

export const cancelInstallmentPlan = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.customercollection.manage")) return sendError(res, 403, "Permission denied.", requestId);
    const userId = req.auth?.userId || req.auth?.id || null;

    const collection = await CustomerCollectionService.cancelInstallmentPlan(req.params.collectionId, req.body, scope.tenantId, userId);
    return sendSuccess(res, 200, "Installment plan cancelled successfully.", collection, requestId);
  } catch (error) {
    console.error("cancelInstallmentPlan error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to cancel installment plan.", requestId);
  }
};

export const settleInstallmentPlanEarly = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.customercollection.manage")) return sendError(res, 403, "Permission denied.", requestId);
    const userId = req.auth?.userId || req.auth?.id || null;

    const result = await CustomerCollectionService.settleInstallmentPlanEarly(req.params.collectionId, scope.tenantId, userId);
    return sendSuccess(res, 200, "Installment plan settled early.", result, requestId);
  } catch (error) {
    console.error("settleInstallmentPlanEarly error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to settle installment plan early.", requestId);
  }
};

// ---- Payment Links ----

export const generatePaymentLink = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.customercollection.manage")) return sendError(res, 403, "Permission denied.", requestId);
    const userId = req.auth?.userId || req.auth?.id || null;

    const collection = await CustomerCollectionService.generatePaymentLink(req.params.collectionId, scope.tenantId, userId);
    return sendSuccess(res, 201, "Payment link generated successfully.", collection, requestId);
  } catch (error) {
    console.error("generatePaymentLink error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to generate payment link.", requestId);
  }
};

/**
 * Public — resolved by the unguessable payment-link token, registered
 * BEFORE router.use(authenticateAccessToken), same convention as Part 8's
 * own GET /receipts/verify/:token. GET-only by design — see
 * CustomerCollectionService.getCollectionByToken's own doc comment.
 */
export const viewCollectionByToken = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const result = await CustomerCollectionService.getCollectionByToken(req.params.token);
    return sendSuccess(res, 200, "Payment link details retrieved successfully.", result, requestId);
  } catch (error) {
    console.error("viewCollectionByToken error:", error);
    return sendError(res, statusFromError(error), error.message || "Payment link not found.", requestId);
  }
};

// ---- Reminders ----

export const sendReminder = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.customercollection.manage")) return sendError(res, 403, "Permission denied.", requestId);
    const userId = req.auth?.userId || req.auth?.id || null;

    const reminder = await CustomerCollectionService.sendReminder(req.params.collectionId, req.body, scope.tenantId, userId);
    return sendSuccess(res, 201, "Reminder sent.", reminder, requestId);
  } catch (error) {
    console.error("sendReminder error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to send reminder.", requestId);
  }
};

export const listCollectionReminders = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.customercollection.read", "finance.read")) return sendError(res, 403, "Permission denied.", requestId);

    const items = await CustomerCollectionService.listCollectionReminders(req.params.collectionId, scope.tenantId);
    return sendSuccess(res, 200, "Collection reminders retrieved successfully.", { items }, requestId);
  } catch (error) {
    console.error("listCollectionReminders error:", error);
    return sendError(res, 500, error.message || "Failed to retrieve collection reminders.", requestId);
  }
};

// ---- Advance Customer Deposits ----

export const createCustomerDeposit = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.customercollection.create")) return sendError(res, 403, "Permission denied.", requestId);
    const userId = req.auth?.userId || req.auth?.id || null;

    const result = await CustomerCollectionService.createCustomerDeposit(req.body, scope.tenantId, userId);
    return sendSuccess(res, 201, "Customer deposit created successfully.", result, requestId);
  } catch (error) {
    console.error("createCustomerDeposit error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to create customer deposit.", requestId);
  }
};

// ---- File 6 Part 5: Attachments ----

export const uploadCollectionAttachment = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.customercollection.manage")) return sendError(res, 403, "Permission denied.", requestId);
    if (!req.file) return sendError(res, 400, "A file is required.", requestId);
    const userId = req.auth?.userId || req.auth?.id || null;

    const attachment = await CustomerCollectionService.uploadAttachment(req.params.collectionId, req.file, scope.tenantId, userId);
    return sendSuccess(res, 201, "Attachment uploaded successfully.", attachment, requestId);
  } catch (error) {
    console.error("uploadCollectionAttachment error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to upload attachment.", requestId);
  }
};

export const listCollectionAttachments = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.customercollection.read", "finance.read")) return sendError(res, 403, "Permission denied.", requestId);

    const items = await CustomerCollectionService.listAttachments(req.params.collectionId, scope.tenantId);
    return sendSuccess(res, 200, "Attachments retrieved successfully.", { items }, requestId);
  } catch (error) {
    console.error("listCollectionAttachments error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to retrieve attachments.", requestId);
  }
};

// ---- Comments ----

export const addCollectionComment = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.customercollection.manage")) return sendError(res, 403, "Permission denied.", requestId);
    const userId = req.auth?.userId || req.auth?.id || null;

    const comment = await CustomerCollectionService.addComment(req.params.collectionId, req.body, scope.tenantId, userId);
    return sendSuccess(res, 201, "Comment added successfully.", comment, requestId);
  } catch (error) {
    console.error("addCollectionComment error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to add comment.", requestId);
  }
};

export const listCollectionComments = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.customercollection.read", "finance.read")) return sendError(res, 403, "Permission denied.", requestId);

    const items = await CustomerCollectionService.listComments(req.params.collectionId, scope.tenantId);
    return sendSuccess(res, 200, "Comments retrieved successfully.", { items }, requestId);
  } catch (error) {
    console.error("listCollectionComments error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to retrieve comments.", requestId);
  }
};

// ---- Manual Timeline Entry ----

export const addCollectionTimelineEntry = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.customercollection.manage")) return sendError(res, 403, "Permission denied.", requestId);
    const userId = req.auth?.userId || req.auth?.id || null;

    const entry = await CustomerCollectionService.addTimelineEntry(req.params.collectionId, req.body, scope.tenantId, userId);
    return sendSuccess(res, 201, "Timeline entry added successfully.", entry, requestId);
  } catch (error) {
    console.error("addCollectionTimelineEntry error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to add timeline entry.", requestId);
  }
};

// ---- Payment Link Regeneration ----

export const regeneratePaymentLink = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.customercollection.manage")) return sendError(res, 403, "Permission denied.", requestId);
    const userId = req.auth?.userId || req.auth?.id || null;

    const result = await CustomerCollectionService.regeneratePaymentLink(req.params.collectionId, scope.tenantId, userId);
    return sendSuccess(res, 200, "Payment link regenerated successfully.", result, requestId);
  } catch (error) {
    console.error("regeneratePaymentLink error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to regenerate payment link.", requestId);
  }
};

// ---- Advance Allocation ----

export const allocateAdvance = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.customercollection.manage")) return sendError(res, 403, "Permission denied.", requestId);
    const userId = req.auth?.userId || req.auth?.id || null;

    const result = await CustomerCollectionService.allocateAdvance(req.params.collectionId, scope.tenantId, userId);
    return sendSuccess(res, 200, "Advance allocated successfully.", result, requestId);
  } catch (error) {
    console.error("allocateAdvance error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to allocate advance.", requestId);
  }
};

// ---- Reopen ----

export const reopenCollection = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.customercollection.approve")) return sendError(res, 403, "Permission denied.", requestId);
    const userId = req.auth?.userId || req.auth?.id || null;

    const result = await CustomerCollectionService.reopenCollection(req.params.collectionId, req.body, scope.tenantId, userId);
    return sendSuccess(res, 200, "Collection reopened successfully.", result, requestId);
  } catch (error) {
    console.error("reopenCollection error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to reopen collection.", requestId);
  }
};

// ---- Audit & History ----

export const getCollectionAuditTrail = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.customercollection.read", "finance.read")) return sendError(res, 403, "Permission denied.", requestId);

    const result = await CustomerCollectionService.getAuditTrail(req.params.collectionId, scope.tenantId, req.query);
    return sendSuccess(res, 200, "Collection audit trail retrieved successfully.", result, requestId);
  } catch (error) {
    console.error("getCollectionAuditTrail error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to retrieve collection audit trail.", requestId);
  }
};

export const getCollectionHistory = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.customercollection.read", "finance.read")) return sendError(res, 403, "Permission denied.", requestId);

    const result = await CustomerCollectionService.getCollectionHistory(req.params.collectionId, scope.tenantId);
    return sendSuccess(res, 200, "Collection history retrieved successfully.", result, requestId);
  } catch (error) {
    console.error("getCollectionHistory error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to retrieve collection history.", requestId);
  }
};
