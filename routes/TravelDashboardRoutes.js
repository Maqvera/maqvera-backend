import express from "express";
import authenticateAccessToken from "../middleware/authenticateAccessToken.js";
import rateLimit from "express-rate-limit";
import {
  GetPrimaryDashboard,
  GetDashboardKPIs,
  GetDashboardTrends,
  GetDashboardMap,
  GetDashboardWorkload,
  GetDashboardAlerts,
  ExportDashboard
} from "../controllers/TravelDashboardController.js";

const router = express.Router();

const limiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 100,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: "Too many requests from this IP, please try again after 10 minutes."
});

router.use(authenticateAccessToken);

// Dashboard & Analytics Routes (Part 10)
router.get("/", limiter, GetPrimaryDashboard);
router.get("/kpis", limiter, GetDashboardKPIs);
router.get("/trends", limiter, GetDashboardTrends);
router.get("/map", limiter, GetDashboardMap);
router.get("/workload", limiter, GetDashboardWorkload);
router.get("/alerts", limiter, GetDashboardAlerts);
router.get("/export", limiter, ExportDashboard);

export default router;
