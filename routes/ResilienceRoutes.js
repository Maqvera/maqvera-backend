import express from "express";
import rateLimit from "express-rate-limit";
import authenticateAccessToken from "../middleware/authenticateAccessToken.js";
import { listDeadLetterQueue, getDeadLetter, permanentlyFailDeadLetter, listCircuitBreakerStatus } from "../controllers/ResilienceController.js";

const router = express.Router();
const limiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 200,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: "Too many requests from this IP, please try again after 10 minutes."
});

// Enterprise Resilience & Reliability Standard (Improvement 6). Real
// operational visibility into the Dead Letter Queue and Circuit Breaker
// state — see controllers/ResilienceController.js's own doc comment for
// why DLQ *reprocessing* is deliberately not exposed as a generic
// endpoint here.
router.use(authenticateAccessToken);

router.get("/dead-letters", limiter, listDeadLetterQueue);
router.get("/dead-letters/:dlqId", limiter, getDeadLetter);
router.post("/dead-letters/:dlqId/permanent-failure", limiter, permanentlyFailDeadLetter);
router.get("/circuit-breakers", limiter, listCircuitBreakerStatus);

export default router;
