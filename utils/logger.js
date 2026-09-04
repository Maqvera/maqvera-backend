import winston from "winston";
import dotenv from "dotenv";
import { getCorrelationId } from "./correlationContext.js";
dotenv.config();

const logLevel = process.env.LOG_LEVEL || (process.env.NODE_ENV === "production" ? "info" : "debug");

// Enterprise Correlation & Traceability Standard — "Every log MUST
// include... correlationId." Reads the current request's correlationId
// from AsyncLocalStorage (utils/correlationContext.js) and stamps it onto
// EVERY log line automatically — every existing `logger.info/warn/error(...)`
// call across this entire codebase (schedulers excluded, since those run
// outside any request context and honestly have no correlationId to
// attach) gets this for free, with zero changes to any individual call
// site. A call site that already passes its own `correlationId` in the
// meta object wins — this only fills the gap when one wasn't supplied.
const correlationFormat = winston.format((info) => {
  if (!info.correlationId) {
    const correlationId = getCorrelationId();
    if (correlationId) info.correlationId = correlationId;
  }
  return info;
});

const logger = winston.createLogger({
  level: logLevel,
  format: winston.format.combine(
    correlationFormat(),
    winston.format.timestamp({ format: "YYYY-MM-DD HH:mm:ss" }),
    winston.format.errors({ stack: true }),
    winston.format.json()
  ),
  defaultMeta: { service: "maqvera-api" },
  transports: [
    new winston.transports.File({ filename: "logs/error.log", level: "error", maxsize: 5242880, maxFiles: 5 }),
    new winston.transports.File({ filename: "logs/combined.log", maxsize: 5242880, maxFiles: 10 }),
  ],
});

if (process.env.NODE_ENV !== "production") {
  logger.add(
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.simple()
      ),
    })
  );
}

export const requestLogger = (req, res, next) => {
  const start = Date.now();
  res.on("finish", () => {
    const duration = Date.now() - start;
    logger.info(req.method + " " + req.originalUrl + " " + res.statusCode + " " + duration + "ms", {
      requestId: req.requestId,
      ip: req.ip,
      method: req.method,
      url: req.originalUrl,
      statusCode: res.statusCode,
      duration: duration,
      userAgent: req.get("User-Agent"),
    });
  });
  next();
};

export default logger;
