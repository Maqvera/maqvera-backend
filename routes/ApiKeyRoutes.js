import express from "express";
import rateLimit from "express-rate-limit";
import authenticateAccessToken from "../middleware/authenticateAccessToken.js";
import validate, { apiKeySchemas } from "../middleware/validateRequest.js";
import { createApiKey, listApiKeys, revokeApiKey } from "../controllers/ApiKeyController.js";

const router = express.Router();
const limiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 100,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: "Too many requests, please try again later."
});

router.use(authenticateAccessToken);

router.get("/", limiter, listApiKeys);
router.post("/", limiter, validate(apiKeySchemas.createApiKey), createApiKey);
router.delete("/:apiKeyId", limiter, revokeApiKey);

export default router;
