import logger from "../utils/logger.js";
import { AppError, sendStandardError } from "../utils/errorContract.js";

export const errorHandler = (err, req, res, _next) => {
  const requestId = req.requestId || null;

  if (err.code === "LIMIT_FILE_SIZE") {
    return sendStandardError(res, new AppError("FILE_TOO_LARGE"), requestId);
  }

  if (err.code === "LIMIT_UNEXPECTED_FILE") {
    return sendStandardError(res, new AppError("UNEXPECTED_FILE_FIELD"), requestId);
  }

  logger.error("Unhandled error", {
    requestId,
    error: err.message,
    stack: err.stack,
    method: req.method,
    url: req.originalUrl,
  });

  // Standard Error Contract (Enterprise Architecture Hardening Phase,
  // Improvement 4) — "Sensitive internal exception details MUST NEVER be
  // exposed." Unchanged from before: production hides the real message
  // behind a generic one; only the full exception (message + stack) ever
  // reaches the logger above, never the HTTP response body.
  const message = process.env.NODE_ENV === "production" ? "Internal server error" : err.message;
  return sendStandardError(res, new AppError("INTERNAL_ERROR", { message }), requestId);
};

export const notFoundHandler = (req, res) => {
  return sendStandardError(res, new AppError("ROUTE_NOT_FOUND", { message: `Route ${req.method} ${req.originalUrl} not found` }), req.requestId || null);
};
