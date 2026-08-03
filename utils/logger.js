import winston from "winston";
import dotenv from "dotenv";
dotenv.config();

const logLevel = process.env.LOG_LEVEL || (process.env.NODE_ENV === "production" ? "info" : "debug");

const logger = winston.createLogger({
  level: logLevel,
  format: winston.format.combine(
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
