import express from "express";
import rateLimit from "express-rate-limit";
import authenticateAccessToken from "../middleware/authenticateAccessToken.js";
import validate, { leadSchemas } from "../middleware/validateRequest.js";
import { createLead, listLeads, getPipeline, getLead, updateLead, convertLead } from "../controllers/LeadController.js";

const router = express.Router();
const limiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 100,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: "Too many requests, please try again later."
});

router.use(authenticateAccessToken);

// Registered before "/:leadId" so GET /leads/pipeline never falls through
// to the dynamic id route — same static-before-dynamic ordering used in
// routes/PackageRoutes.js.
router.get("/pipeline", limiter, getPipeline);

router.get("/", limiter, listLeads);
router.post("/", limiter, validate(leadSchemas.createLead), createLead);
router.get("/:leadId", limiter, getLead);
router.patch("/:leadId", limiter, validate(leadSchemas.updateLead), updateLead);
router.post("/:leadId/convert", limiter, validate(leadSchemas.convertLead), convertLead);

export default router;
