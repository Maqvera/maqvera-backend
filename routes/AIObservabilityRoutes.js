import express from "express";
import rateLimit from "express-rate-limit";
import authenticateAccessToken from "../middleware/authenticateAccessToken.js";
import {
  GetRequestMetrics,
  GetLLMMetrics,
  GetToolMetrics,
  GetRAGMetrics,
  GetAgentMetrics,
  GetMemoryMetrics,
  GetQualityMetrics,
  GetCostMetrics,
  GetPromptDashboard,
  GetSecurityMetrics,
  GetProviderDashboard,
  GetHealthScore,
  GetExecutiveDashboard,
  ListAlerts,
  EvaluateAlerts
} from "../controllers/AIObservabilityController.js";

const router = express.Router();

const limiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 60,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: "Too many AI observability requests from this IP, please try again after 10 minutes."
});

router.use(authenticateAccessToken, limiter);

router.get("/requests", GetRequestMetrics);
router.get("/llm", GetLLMMetrics);
router.get("/tools", GetToolMetrics);
router.get("/rag", GetRAGMetrics);
router.get("/agents", GetAgentMetrics);
router.get("/memory", GetMemoryMetrics);
router.get("/quality", GetQualityMetrics);
router.get("/cost", GetCostMetrics);
router.get("/prompts", GetPromptDashboard);
router.get("/security", GetSecurityMetrics);
router.get("/providers", GetProviderDashboard);
router.get("/health", GetHealthScore);
router.get("/dashboard/executive", GetExecutiveDashboard);
router.get("/alerts", ListAlerts);
router.post("/alerts/evaluate", EvaluateAlerts);

export default router;
