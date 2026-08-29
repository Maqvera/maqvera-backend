import express from "express";
import rateLimit from "express-rate-limit";
import authenticateAccessToken from "../middleware/authenticateAccessToken.js";
import authenticateAgentToken from "../middleware/authenticateAgentToken.js";
import validate, { agentSchemas } from "../middleware/validateRequest.js";
import {
  createAgent, listAgents, suspendAgent, getAgentPerformanceReport,
  agentLogin,
  getMyDashboard, getMyBookings, createMyBooking, getMyWallet
} from "../controllers/AgentPortalController.js";

const router = express.Router();
const limiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 100,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: "Too many requests, please try again later."
});
// Agent login is the one public-unauthenticated surface on this router —
// a tighter limiter, same discipline routes/PublicBookingRoutes.js-style
// endpoints apply elsewhere for the one truly public surface.
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: "Too many login attempts, please try again later."
});

// ---- Agent-side auth (public) ----
router.post("/login", loginLimiter, validate(agentSchemas.agentLogin), agentLogin);

// ---- Agent-side portal (own token, own scope only) ----
router.get("/me/dashboard", authenticateAgentToken, limiter, getMyDashboard);
router.get("/me/bookings", authenticateAgentToken, limiter, getMyBookings);
router.post("/me/bookings", authenticateAgentToken, limiter, createMyBooking);
router.get("/me/wallet", authenticateAgentToken, limiter, getMyWallet);

// ---- Staff-side management (tenant staff, existing token) ----
// Static routes registered before "/:agentId..." on purpose — same
// static-before-dynamic ordering used elsewhere in this codebase, so
// GET /agents/reports/performance is never accidentally shadowed.
router.get("/reports/performance", authenticateAccessToken, limiter, getAgentPerformanceReport);
router.get("/", authenticateAccessToken, limiter, listAgents);
router.post("/", authenticateAccessToken, limiter, validate(agentSchemas.createAgent), createAgent);
router.post("/:agentId/suspend", authenticateAccessToken, limiter, suspendAgent);

export default router;
