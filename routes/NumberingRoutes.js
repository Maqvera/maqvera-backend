import express from "express";
import rateLimit from "express-rate-limit";
import authenticateAccessToken from "../middleware/authenticateAccessToken.js";
import validate, { numberingSchemas } from "../middleware/validateRequest.js";
import idempotency from "../middleware/idempotency.js";
import {
  createScheme, listSchemes, getScheme, updateScheme,
  generateNumber, registerResource, rollbackSequence, resetSequence,
  listHistory
} from "../controllers/NumberGeneratorController.js";

const router = express.Router();
const limiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 300,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: "Too many requests from this IP, please try again after 10 minutes."
});

// Enterprise Identity & Global Resource ID Platform (Improvement 5). File
// 0's own literal `/api/v1/numbering/schemes`, `/api/v1/numbering/generate`,
// `/api/v1/numbering/history` contract, plus register/rollback/reset —
// real additions the lifecycle events (ResourceRegistered,
// SequenceRolledBack, SequenceReset) require a real endpoint to trigger.
// Mounted at `/api/v1/numbering` in server.js.
router.use(authenticateAccessToken);

router.post("/schemes", limiter, idempotency(), validate(numberingSchemas.createScheme), createScheme);
router.get("/schemes", limiter, listSchemes);
router.get("/schemes/:schemeId", limiter, getScheme);
router.patch("/schemes/:schemeId", limiter, validate(numberingSchemas.updateScheme), updateScheme);
router.post("/schemes/:schemeId/reset", limiter, validate(numberingSchemas.resetSequence), resetSequence);

router.post("/generate", limiter, idempotency(), validate(numberingSchemas.generateNumber), generateNumber);
router.post("/:generatedNumberId/register", limiter, validate(numberingSchemas.registerResource), registerResource);
router.post("/:generatedNumberId/rollback", limiter, validate(numberingSchemas.rollbackSequence), rollbackSequence);

router.get("/history", limiter, listHistory);

export default router;
