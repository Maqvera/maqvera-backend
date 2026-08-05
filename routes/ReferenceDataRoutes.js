import express from "express";
import rateLimit from "express-rate-limit";
import authenticateAccessToken from "../middleware/authenticateAccessToken.js";
import { GetReferenceAirports, GetReferenceAirlines, GetReferenceAircraft, GetReferenceCountries, GetReferenceCities, SearchReferenceAirports, SelectReferenceAirportSuggestion } from "../controllers/ReferenceDataController.js";

const router = express.Router();

// A more generous limit than other integration routes — §"Why EXT-013 is
// Important" explicitly expects this to be hit more frequently than flight
// search itself (every dropdown/autocomplete/AI lookup across the
// platform), and every read here is served from the local master tables/
// cache, never a live Amadeus call per request.
const limiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 600,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: "Too many requests from this IP, please try again after 10 minutes."
});

router.use(authenticateAccessToken, limiter);

// EXT-013.
router.get("/airports", GetReferenceAirports);
router.get("/airlines", GetReferenceAirlines);
router.get("/aircraft", GetReferenceAircraft);
router.get("/countries", GetReferenceCountries);
router.get("/cities", GetReferenceCities);

// EXT-014.
router.get("/airports/search", SearchReferenceAirports);
router.post("/airports/search/select", SelectReferenceAirportSuggestion);

export default router;
