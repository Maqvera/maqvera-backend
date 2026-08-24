import express from "express";
import rateLimit from "express-rate-limit";
import authenticateAccessToken from "../middleware/authenticateAccessToken.js";
import validate, { kpiDefinitionSchemas } from "../middleware/validateRequest.js";
import {
  registerKPIDefinition,
  listKPIDefinitions,
  getKPIDefinition,
  deprecateKPIDefinition
} from "../controllers/KPIDefinitionController.js";

const router = express.Router();

const limiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 100,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: "Too many requests from this IP, please try again after 10 minutes."
});

router.use(authenticateAccessToken);

// Reporting Platform Part 5 fix — KPI definition registry (KPIDefinitionModel).
router.post("/", limiter, validate(kpiDefinitionSchemas.registerKPIDefinition), registerKPIDefinition);
router.get("/", limiter, listKPIDefinitions);
router.get("/:kpiKey", limiter, getKPIDefinition);
router.post("/:kpiKey/deprecate", limiter, validate(kpiDefinitionSchemas.deprecateKPIDefinition), deprecateKPIDefinition);

export default router;
