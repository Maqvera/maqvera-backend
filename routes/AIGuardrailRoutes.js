import express from "express";
import rateLimit from "express-rate-limit";
import authenticateAccessToken from "../middleware/authenticateAccessToken.js";
import {
  CreatePolicy,
  ListPolicies,
  UpdatePolicy,
  DeletePolicy,
  ListGuardrailAudit,
  GetGuardrailMetrics
} from "../controllers/AIGuardrailController.js";

const router = express.Router();

const limiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 30,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: "Too many AI guardrail management requests from this IP, please try again after 10 minutes."
});

router.use(authenticateAccessToken, limiter);

// Fixed-segment routes registered before "/policies/:policyId" wildcards.
router.get("/audit", ListGuardrailAudit);
router.get("/metrics", GetGuardrailMetrics);

router.post("/policies", CreatePolicy);
router.get("/policies", ListPolicies);
router.patch("/policies/:policyId", UpdatePolicy);
router.delete("/policies/:policyId", DeletePolicy);

export default router;
