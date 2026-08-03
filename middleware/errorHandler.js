import logger from "../utils/logger.js";

export const errorHandler = (err, req, res, _next) => {
  const requestId = req.requestId || null;

  if (err.code === "LIMIT_FILE_SIZE") {
    return res.status(413).json({
      success: false,
      message: "File too large",
      requestId,
    });
  }

  if (err.code === "LIMIT_UNEXPECTED_FILE") {
    return res.status(400).json({
      success: false,
      message: "Unexpected file field",
      requestId,
    });
  }

  logger.error("Unhandled error", {
    requestId,
    error: err.message,
    stack: err.stack,
    method: req.method,
    url: req.originalUrl,
  });

  return res.status(500).json({
    success: false,
    message: process.env.NODE_ENV === "production" ? "Internal server error" : err.message,
    requestId,
  });
};

export const notFoundHandler = (req, res) => {
  return res.status(404).json({
    success: false,
    message: `Route ${req.method} ${req.originalUrl} not found`,
    requestId: req.requestId || null,
  });
};
