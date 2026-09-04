import express from "express";
import rateLimit from "express-rate-limit";
import authenticateAccessToken from "../middleware/authenticateAccessToken.js";
import validate, { reportTemplateSchemas } from "../middleware/validateRequest.js";
import {
  createReportTemplate,
  listReportTemplates,
  getReportTemplate,
  updateReportTemplate,
  publishReportTemplate,
  archiveReportTemplate
} from "../controllers/ReportTemplateController.js";

const router = express.Router();

const limiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 100,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: "Too many requests from this IP, please try again after 10 minutes."
});

router.use(authenticateAccessToken);

// Reporting Platform Part 8 fix — report template registry (ReportTemplateModel).
router.post("/", limiter, validate(reportTemplateSchemas.createReportTemplate), createReportTemplate);
router.get("/", limiter, listReportTemplates);
router.get("/:templateKey", limiter, getReportTemplate);
router.patch("/:templateKey", limiter, validate(reportTemplateSchemas.updateReportTemplate), updateReportTemplate);
router.post("/:templateKey/publish", limiter, validate(reportTemplateSchemas.templateLocaleAction), publishReportTemplate);
router.post("/:templateKey/archive", limiter, validate(reportTemplateSchemas.templateLocaleAction), archiveReportTemplate);

export default router;
