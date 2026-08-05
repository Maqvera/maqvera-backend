import express from "express";
import rateLimit from "express-rate-limit";
import authenticateAccessToken from "../middleware/authenticateAccessToken.js";
import { PerformFlightCheckIn } from "../controllers/FlightCheckInController.js";

const router = express.Router();

const limiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 100,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: "Too many requests from this IP, please try again after 10 minutes."
});

router.use(authenticateAccessToken, limiter);

// EXT-010. Mounted at "/api/v1/integrations/airlines" — a deliberately
// separate namespace from "/api/v1/integrations/amadeus" (AmadeusIntegrationRoutes.js),
// since check-in is a generic, airline-specific capability, not part of
// Amadeus's own API surface. Future generic airline documents (boarding
// pass retrieval, flight changes, baggage, refunds, ancillary services)
// land here too.
router.post("/check-in", PerformFlightCheckIn);

export default router;
