import express from "express";
import rateLimit from "express-rate-limit";
import authenticateAccessToken from "../middleware/authenticateAccessToken.js";
import {
  SearchFlights,
  GetSearchById,
  RevalidateOffer,
  GetCalendarSearch,
  GetFareRules,
  GetBaggageInfo,
  GetSeatMap,
  GetAirlinePricing,
  GetProviderStatus
} from "../controllers/FlightSearchController.js";

const router = express.Router();

const limiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 100,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: "Too many requests from this IP, please try again after 10 minutes."
});

// "Authentication: Required (Bearer JWT)" / "Authorization: Required
// (flight.search)" — every route here was previously completely public.
router.use(authenticateAccessToken, limiter);

// Live Flight Availability Search
router.post("/", SearchFlights);

// Health & Status of Providers
router.get("/providers/status", GetProviderStatus);

// Cached Search Result Lookup
router.get("/:searchId", GetSearchById);

// Offer Revalidation
router.post("/revalidate", RevalidateOffer);

// Flexible Date Calendar Search
router.post("/calendar", GetCalendarSearch);

// Fare Rules & Cancellation Fees
router.post("/fare-rules", GetFareRules);

// Baggage Information
router.post("/baggage", GetBaggageInfo);

// Live Seat Map
router.post("/seat-map", GetSeatMap);

// Dynamic Airline Pricing
router.post("/airline-pricing", GetAirlinePricing);

export default router;
