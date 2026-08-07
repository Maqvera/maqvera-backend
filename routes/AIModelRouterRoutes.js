import express from "express";
import rateLimit from "express-rate-limit";
import authenticateAccessToken from "../middleware/authenticateAccessToken.js";
import {
  GetModelCatalog,
  GetProviderHealth,
  UpsertRoutingPolicy,
  ListRoutingPolicies,
  DeleteRoutingPolicy,
  CreateABTest,
  StartABTest,
  CancelABTest,
  ListABTests,
  GetABTestResults,
  PromoteABTestWinner,
  ListShadowTestResults
} from "../controllers/AIModelRouterController.js";

const router = express.Router();

const limiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 60,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: "Too many AI model router requests from this IP, please try again after 10 minutes."
});

router.use(authenticateAccessToken, limiter);

router.get("/catalog", GetModelCatalog);
router.get("/providers/health", GetProviderHealth);

router.post("/routing-policies", UpsertRoutingPolicy);
router.get("/routing-policies", ListRoutingPolicies);
router.delete("/routing-policies/:category", DeleteRoutingPolicy);

router.post("/ab-tests", CreateABTest);
router.get("/ab-tests", ListABTests);
router.post("/ab-tests/:testId/start", StartABTest);
router.post("/ab-tests/:testId/cancel", CancelABTest);
router.get("/ab-tests/:testId/results", GetABTestResults);
router.post("/ab-tests/:testId/promote", PromoteABTestWinner);

router.get("/shadow-tests", ListShadowTestResults);

export default router;
