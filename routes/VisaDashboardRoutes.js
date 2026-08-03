import express from "express";
import rateLimit from "express-rate-limit";
import authenticateAccessToken from "../middleware/authenticateAccessToken.js";
import {
  getVisaExecutiveDashboard,
  getVisaOperationsDashboard,
  getVisaOfficerDashboard,
  getVisaEmbassyDashboard,
  getVisaBranchDashboard,
  getVisaFinanceDashboard,
  getVisaCustomerDashboard,
  getVisaComplianceDashboard,
  getVisaAiInsightsDashboard,
  getVisaDashboardKPIs,
  getVisaDashboardTrends,
} from "../controllers/VisaDashboardController.js";

const router = express.Router();
const limiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 100,
  standardHeaders: "draft-7",
  legacyHeaders: false,
});

router.use(authenticateAccessToken, limiter);

router.get("/executive", getVisaExecutiveDashboard);
router.get("/operations", getVisaOperationsDashboard);
router.get("/officer", getVisaOfficerDashboard);
router.get("/embassy", getVisaEmbassyDashboard);
router.get("/branch", getVisaBranchDashboard);
router.get("/finance", getVisaFinanceDashboard);
router.get("/customer", getVisaCustomerDashboard);
router.get("/compliance", getVisaComplianceDashboard);
router.get("/ai-insights", getVisaAiInsightsDashboard);
router.get("/kpis", getVisaDashboardKPIs);
router.get("/trends", getVisaDashboardTrends);

export default router;
