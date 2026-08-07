import express from "express";
import rateLimit from "express-rate-limit";
import authenticateAccessToken from "../middleware/authenticateAccessToken.js";
import {
  CreatePrompt,
  CreatePromptVersion,
  TransitionPromptVersionStatus,
  RollbackPrompt,
  ListPrompts,
  GetPromptById,
  CreateTestCase,
  ListTestCases,
  DeleteTestCase,
  RunPromptTestSuite
} from "../controllers/AIPromptController.js";

const router = express.Router();

const limiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 30,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: "Too many AI prompt management requests from this IP, please try again after 10 minutes."
});

router.use(authenticateAccessToken, limiter);

// Fixed-segment routes registered before "/:promptId" wildcards.
router.delete("/test-cases/:testCaseId", DeleteTestCase);

router.post("/", CreatePrompt);
router.get("/", ListPrompts);
router.get("/:promptId", GetPromptById);
router.post("/:promptId/versions", CreatePromptVersion);
router.patch("/:promptId/versions/:version/status", TransitionPromptVersionStatus);
router.post("/:promptId/versions/:version/run-tests", RunPromptTestSuite);
router.post("/:promptId/rollback", RollbackPrompt);
router.post("/:promptId/test-cases", CreateTestCase);
router.get("/:promptId/test-cases", ListTestCases);

export default router;
