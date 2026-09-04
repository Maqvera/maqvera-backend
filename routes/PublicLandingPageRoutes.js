import express from "express";
import rateLimit from "express-rate-limit";
import resolveTenantByHost from "../middleware/resolveTenantByHost.js";
import { RenderLandingPage } from "../controllers/PublicLandingPageController.js";

// Per-Tenant Domain-Masked Landing Page (PRD v2 §2.3/Task D). Rate-limited
// with the same express-rate-limit convention every other genuinely public,
// unauthenticated router in this codebase already uses (routes/
// PublicBookingRoutes.js, routes/AgentPortalRoutes.js's /login) — not
// middleware/rateLimiter.js's enterpriseRateLimit (a tenant/user-JWT-scoped
// distributed limiter meant for the authenticated API), for consistency
// with those existing public surfaces rather than introducing a third,
// inconsistent rate-limiting approach on this one route.
const router = express.Router();
const limiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 300,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: "Too many requests, please try again later."
});

router.get("/", limiter, resolveTenantByHost, RenderLandingPage);

export default router;
