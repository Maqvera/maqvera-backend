import express from "express";
import rateLimit from "express-rate-limit";
import authenticateAccessToken from "../middleware/authenticateAccessToken.js";
import { createOrUpdateRateLimitRule, listRateLimitRulesHandler, listRateLimitViolations, getRateLimitTopConsumers } from "../controllers/RateLimitController.js";

const router = express.Router();
const limiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 200,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: "Too many requests from this IP, please try again after 10 minutes."
});

// Enterprise API Rate Limiting & Throttling Standard (Improvement 13).
// Rule management + monitoring read surface — see
// controllers/RateLimitController.js's own doc comment.
router.use(authenticateAccessToken);

router.post("/rules", limiter, createOrUpdateRateLimitRule);
router.get("/rules", limiter, listRateLimitRulesHandler);
router.get("/violations", limiter, listRateLimitViolations);
router.get("/top-consumers", limiter, getRateLimitTopConsumers);

export default router;
