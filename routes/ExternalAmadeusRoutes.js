import express from "express";
import rateLimit from "express-rate-limit";
import authenticateAccessToken from "../middleware/authenticateAccessToken.js";
import { VerifyFlightPricing } from "../controllers/ExternalAmadeusPricingController.js";

const router = express.Router();

const limiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 100,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: "Too many requests from this IP, please try again after 10 minutes."
});

router.use(authenticateAccessToken, limiter);

// EXT-003. Future EXT-004/005/006 (booking/ticketing/cancellation) land in
// this same "amadeus" sub-router as their own documents are implemented.
router.post("/flights/pricing", VerifyFlightPricing);

export default router;
