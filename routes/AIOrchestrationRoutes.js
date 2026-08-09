import express from "express";
import rateLimit from "express-rate-limit";
import authenticateAccessToken from "../middleware/authenticateAccessToken.js";
import {
  ListTools,
  GetToolById,
  ValidateToolCall,
  CreatePlan,
  ExecutePlan,
  CancelExecution,
  ArchiveExecution,
  DecideApproval,
  ListExecutions,
  GetExecutionById,
  GetWorkflowMetrics,
  GetOrchestrationProviderStatus
} from "../controllers/AIOrchestrationController.js";

const router = express.Router();

const limiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 30,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: "Too many AI requests from this IP, please try again after 10 minutes."
});

router.use(authenticateAccessToken, limiter);

// Fixed-segment routes must be registered before the "/tools/:toolId"
// wildcard, or Express would try to match "plan"/"validate"/etc. as a toolId.
router.get("/tools/providers/status", GetOrchestrationProviderStatus);
router.post("/tools/plan", CreatePlan);
router.post("/tools/execute", ExecutePlan);
router.post("/tools/validate", ValidateToolCall);
router.post("/tools/approval", DecideApproval);
router.get("/tools/:toolId", GetToolById);
router.get("/tools", ListTools);

router.post("/executions/:executionId/cancel", CancelExecution);
router.post("/executions/:executionId/archive", ArchiveExecution);
router.get("/executions/metrics", GetWorkflowMetrics);
router.get("/executions/:executionId", GetExecutionById);
router.get("/executions", ListExecutions);

export default router;
