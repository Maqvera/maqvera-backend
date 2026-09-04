import express from "express";
import rateLimit from "express-rate-limit";
import authenticateAccessToken from "../middleware/authenticateAccessToken.js";
import validate, { reportCatalogSchemas } from "../middleware/validateRequest.js";
import {
  registerReportCatalogEntry,
  listReportCatalogEntries,
  getReportCatalogEntry,
  transitionReportCatalogLifecycle
} from "../controllers/ReportCatalogController.js";

const router = express.Router();

const limiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 100,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: "Too many requests from this IP, please try again after 10 minutes."
});

router.use(authenticateAccessToken);

// Reporting Platform Part 2 fix — report catalog registry (ReportCatalogModel).
router.post("/", limiter, validate(reportCatalogSchemas.registerReportCatalogEntry), registerReportCatalogEntry);
router.get("/", limiter, listReportCatalogEntries);
router.get("/:reportKey", limiter, getReportCatalogEntry);
router.post("/:reportKey/lifecycle", limiter, validate(reportCatalogSchemas.transitionReportCatalogLifecycle), transitionReportCatalogLifecycle);

export default router;
