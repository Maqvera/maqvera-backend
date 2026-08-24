import express from "express";
import rateLimit from "express-rate-limit";
import authenticateAccessToken from "../middleware/authenticateAccessToken.js";
import { getReportUsageSummary } from "../controllers/ReportUsageController.js";

const router = express.Router();

const limiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 100,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: "Too many requests from this IP, please try again after 10 minutes."
});

router.use(authenticateAccessToken);

// Reporting Platform Part 12 fix — report/dashboard usage analytics (ReportUsageSummaryModel).
router.get("/", limiter, getReportUsageSummary);

export default router;
