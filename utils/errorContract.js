import { sendError } from "./apiResponse.js";

// Enterprise Architecture Hardening Phase — Standard Error Contract
// (Improvement 4). A machine-readable, consistent error model layered
// ON TOP of this codebase's existing `sendError(res, statusCode, message,
// requestId, data)` envelope (`utils/apiResponse.js`) — never replacing
// it, since hundreds of existing controllers already call `sendError`
// directly and depend on its exact top-level shape
// (`{ success, message, data, requestId }`).
//
// The spec's own example response is flat (`{ code, message, category,
// severity, httpStatus, correlationId, timestamp, details }` with no
// `success`/`data` wrapper) — deliberately adapted here to nest under
// `data` instead, the same precedent already set by Improvement 2's
// `VersionConflictError`/`sendVersionConflict` and Improvement 3's
// `IDEMPOTENCY_KEY_REUSED` response before this file existed (both now
// rebuilt on top of this same catalog, see their own files). `requestId`
// (top-level) and `data.correlationId` are intentionally the same value —
// consistent with that established precedent, not a new inconsistency.

export const ERROR_CATEGORIES = [
  "Validation", "Business", "Authorization", "Authentication", "Concurrency",
  "Integration", "Infrastructure", "Security", "Compliance", "System"
];

export const ERROR_SEVERITIES = ["Info", "Warning", "Error", "Critical"];

// code -> { category, httpStatus, message }. Real catalog covering the
// spec's own category examples, its full "Financial Error Examples" list,
// and this codebase's own already-real cross-cutting error codes
// (Optimistic Locking / Idempotency). `message` here is only the DEFAULT
// — any call site can still supply a more specific message, exactly like
// every existing `sendError(res, status, "specific message", ...)` call
// already does.
export const ERROR_CATALOG = {
  // Validation
  VALIDATION_FAILED: { category: "Validation", httpStatus: 400, message: "Validation failed." },
  INVALID_CURRENCY: { category: "Validation", httpStatus: 400, message: "Invalid currency." },
  INVALID_EXCHANGE_RATE: { category: "Validation", httpStatus: 400, message: "Invalid exchange rate." },
  INVALID_TAX_RULE: { category: "Validation", httpStatus: 400, message: "Invalid tax rule." },
  INVALID_IDEMPOTENCY_KEY_FORMAT: { category: "Validation", httpStatus: 400, message: "Idempotency-Key must be a valid UUID." },
  IDEMPOTENCY_KEY_REQUIRED: { category: "Validation", httpStatus: 400, message: "Idempotency-Key header is required for this endpoint." },

  // Authentication
  TOKEN_EXPIRED: { category: "Authentication", httpStatus: 401, message: "Token has expired." },
  UNAUTHENTICATED: { category: "Authentication", httpStatus: 401, message: "Authentication is required." },

  // Authorization
  PERMISSION_DENIED: { category: "Authorization", httpStatus: 403, message: "Permission denied." },
  TENANT_REQUIRED: { category: "Authorization", httpStatus: 403, message: "Tenant context is required." },

  // Concurrency
  VERSION_CONFLICT: { category: "Concurrency", httpStatus: 409, message: "Resource has been modified by another user." },
  VERSION_REQUIRED: { category: "Concurrency", httpStatus: 400, message: "This update requires a version (body.version) or If-Match header." },

  // Business — spec's own "Financial Error Examples" list, plus the
  // generic PAYMENT_ALREADY_EXISTS/IDEMPOTENCY_KEY_REUSED examples.
  PAYMENT_ALREADY_EXISTS: { category: "Business", httpStatus: 409, message: "Payment already exists." },
  IDEMPOTENCY_KEY_REUSED: { category: "Business", httpStatus: 409, message: "The same Idempotency-Key was used with a different request payload." },
  ACCOUNT_ALREADY_CLOSED: { category: "Business", httpStatus: 409, message: "Account is already closed." },
  ACCOUNTING_PERIOD_CLOSED: { category: "Business", httpStatus: 422, message: "Accounting period is closed." },
  DUPLICATE_PAYMENT: { category: "Business", httpStatus: 409, message: "Duplicate payment detected." },
  PAYMENT_ALREADY_SETTLED: { category: "Business", httpStatus: 409, message: "Payment has already been settled." },
  FX_RATE_NOT_FOUND: { category: "Business", httpStatus: 422, message: "No exchange rate found for the requested currency pair." },
  INSUFFICIENT_BALANCE: { category: "Business", httpStatus: 409, message: "Insufficient balance." },
  INSUFFICIENT_CREDIT_LIMIT: { category: "Business", httpStatus: 409, message: "Insufficient credit limit." },
  VENDOR_BLOCKED: { category: "Business", httpStatus: 403, message: "Vendor is blocked." },
  CUSTOMER_BLOCKED: { category: "Business", httpStatus: 403, message: "Customer is blocked." },
  BUDGET_EXCEEDED: { category: "Business", httpStatus: 409, message: "Budget exceeded." },
  APPROVAL_REQUIRED: { category: "Business", httpStatus: 422, message: "Approval is required before this action can proceed." },
  APPROVAL_ALREADY_COMPLETED: { category: "Business", httpStatus: 409, message: "This approval has already been completed." },
  SETTLEMENT_ALREADY_PROCESSED: { category: "Business", httpStatus: 409, message: "Settlement has already been processed." },
  SUBSCRIPTION_EXPIRED: { category: "Business", httpStatus: 402, message: "Subscription has expired." },
  MERCHANT_DISABLED: { category: "Business", httpStatus: 403, message: "Merchant is disabled." },
  TENANT_DISABLED: { category: "Business", httpStatus: 403, message: "Tenant is disabled." },
  NOT_FOUND: { category: "Business", httpStatus: 404, message: "Resource not found." },
  ALREADY_EXISTS: { category: "Business", httpStatus: 409, message: "Resource already exists." },

  // Integration / Infrastructure
  BANK_API_TIMEOUT: { category: "Integration", httpStatus: 503, message: "The bank's API did not respond in time." },
  EXTERNAL_SERVICE_ERROR: { category: "Integration", httpStatus: 502, message: "An external service returned an error." },
  RATE_LIMITED: { category: "Infrastructure", httpStatus: 429, message: "Too many requests." },
  FILE_TOO_LARGE: { category: "Validation", httpStatus: 413, message: "File too large." },
  UNEXPECTED_FILE_FIELD: { category: "Validation", httpStatus: 400, message: "Unexpected file field." },
  ROUTE_NOT_FOUND: { category: "Business", httpStatus: 404, message: "Route not found." },

  // Event Versioning Standard (Improvement 7).
  EVENT_VERSION_RETIRED: { category: "System", httpStatus: 410, message: "This event version has been retired and can no longer be published." },
  EVENT_REGISTRY_CONFLICT: { category: "System", httpStatus: 409, message: "This event name/version is already registered with a different owner or category." },

  // API Version Strategy Standard (Improvement 8).
  API_VERSION_UNAVAILABLE: { category: "System", httpStatus: 410, message: "This API version has reached its sunset date and is no longer available." },
  API_VERSION_REGISTRY_CONFLICT: { category: "System", httpStatus: 409, message: "This API/version is already registered with a different owner." },

  // System — the honest fallback when nothing more specific is known.
  INTERNAL_ERROR: { category: "System", httpStatus: 500, message: "An unexpected error occurred." }
};

const defaultSeverityForStatus = (httpStatus) => (httpStatus >= 500 ? "Critical" : "Error");

/**
 * A real, catalog-backed error. `new AppError("INSUFFICIENT_BALANCE")` picks
 * up category/httpStatus/message from `ERROR_CATALOG`; any field can still
 * be overridden per call site (e.g. a more specific message, or
 * field-level `details` for a validation failure).
 */
export class AppError extends Error {
  constructor(code, overrides = {}) {
    const catalogEntry = ERROR_CATALOG[code] || {};
    const httpStatus = overrides.httpStatus || catalogEntry.httpStatus || 500;
    super(overrides.message || catalogEntry.message || code);
    this.name = "AppError";
    this.code = code;
    this.category = overrides.category || catalogEntry.category || "System";
    this.httpStatus = httpStatus;
    this.severity = overrides.severity || catalogEntry.severity || defaultSeverityForStatus(httpStatus);
    this.details = overrides.details || null;
  }
}

/** Pure builder — `{ code, category, severity, httpStatus, correlationId, timestamp, details }`. `details` is omitted entirely (not `null`) when absent, so JSON.stringify drops the key rather than sending a noisy `"details": null`. */
export const buildErrorPayload = (error, correlationId) => {
  const payload = {
    code: error.code || "INTERNAL_ERROR",
    category: error.category || "System",
    severity: error.severity || "Error",
    httpStatus: error.httpStatus || 500,
    correlationId: correlationId || null,
    timestamp: new Date().toISOString()
  };
  if (error.details) payload.details = error.details;
  return payload;
};

/** Sends the standard contract through the existing `sendError` envelope — the real, single call site every AppError-aware handler should use. `extra` merges additional call-site-specific fields onto `data` (e.g. Optimistic Locking's own `currentVersion`) without inventing a second response builder per standard. */
export const sendStandardError = (res, error, requestId, extra = {}) => {
  const payload = { ...buildErrorPayload(error, requestId), ...extra };
  return sendError(res, payload.httpStatus, error.message || ERROR_CATALOG[payload.code]?.message || "An error occurred.", requestId, payload);
};

/** `[{ field, message }]` from a Joi validation error's own `error.details` — real field-level detail, not a single joined string. */
export const fieldDetailsFromJoiError = (joiError) => {
  if (!joiError?.details) return [];
  return joiError.details.map((detail) => ({
    field: detail.path?.join(".") || null,
    message: detail.message
  }));
};
