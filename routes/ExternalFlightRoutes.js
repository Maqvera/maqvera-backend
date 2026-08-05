import express from "express";
import rateLimit from "express-rate-limit";
import authenticateAccessToken from "../middleware/authenticateAccessToken.js";
import { SearchAmadeusFlights, GetAmadeusMetrics } from "../controllers/ExternalFlightController.js";

const router = express.Router();

const limiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 100,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: "Too many requests from this IP, please try again after 10 minutes."
});

router.use(authenticateAccessToken, limiter);

router.get("/flights/search", SearchAmadeusFlights);
router.get("/flights/metrics", GetAmadeusMetrics);

export default router;
