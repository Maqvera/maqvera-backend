import express from "express";
import authenticateAccessToken from "../middleware/authenticateAccessToken.js";
import rateLimit from "express-rate-limit";
import {
  ListIncidents,
  CreateIncident,
  GetIncidentDetails,
  UpdateIncident,
  AssignIncident,
  ResolveIncident,
  AddIncidentEvidence,
  VerifyIncident,
  CloseIncident,
  ReopenIncident,
  AddIncidentAttachment,
  AddIncidentComment,
  AddIncidentTask,
  UpdateIncidentInvestigation,
  GetIncidentAnalytics
} from "../controllers/TravelIncidentController.js";

const router = express.Router();

const limiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 100,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: "Too many requests from this IP, please try again after 10 minutes."
});

router.use(authenticateAccessToken);

// Centralized Incident Engine Routes
router.get("/analytics", limiter, GetIncidentAnalytics);
router.get("/", limiter, ListIncidents);
router.post("/", limiter, CreateIncident);
router.get("/:incidentId", limiter, GetIncidentDetails);
router.patch("/:incidentId", limiter, UpdateIncident);
router.post("/:incidentId/assign", limiter, AssignIncident);
router.post("/:incidentId/resolve", limiter, ResolveIncident);
router.post("/:incidentId/investigation/evidence", limiter, AddIncidentEvidence);
router.post("/:incidentId/verify", limiter, VerifyIncident);
router.post("/:incidentId/close", limiter, CloseIncident);
router.post("/:incidentId/reopen", limiter, ReopenIncident);
router.post("/:incidentId/attachments", limiter, AddIncidentAttachment);
router.post("/:incidentId/comments", limiter, AddIncidentComment);
router.post("/:incidentId/tasks", limiter, AddIncidentTask);
router.post("/:incidentId/investigation", limiter, UpdateIncidentInvestigation);

export default router;
