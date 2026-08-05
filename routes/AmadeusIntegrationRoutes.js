import express from "express";
import rateLimit from "express-rate-limit";
import authenticateAccessToken from "../middleware/authenticateAccessToken.js";
import idempotency from "../middleware/idempotency.js";
import { CreateAmadeusFlightBooking } from "../controllers/AmadeusFlightBookingController.js";
import { IssueAmadeusFlightTicket } from "../controllers/AmadeusFlightTicketingController.js";
import { GetAmadeusFlightOrderSeatMap } from "../controllers/AmadeusSeatMapController.js";
import { AssignAmadeusSeats } from "../controllers/AmadeusSeatSelectionController.js";
import { GetAmadeusFlightStatus } from "../controllers/AmadeusFlightStatusController.js";
import { GetAmadeusFlightSchedules } from "../controllers/AmadeusFlightScheduleController.js";
import { GetAmadeusFlightInspiration, RecordInspirationFeedback } from "../controllers/AmadeusFlightInspirationController.js";
import { GetAmadeusBrandedFares, RecordBrandedFareRecommendation } from "../controllers/AmadeusFlightBrandedFaresController.js";
import { GetAmadeusAncillaryServices, RecordAncillarySelection } from "../controllers/AmadeusAncillaryServicesController.js";
import { TriggerFlightScheduleSync } from "../controllers/FlightScheduleSyncController.js";
import { GetAmadeusHotelSearch, RecordHotelViewed } from "../controllers/AmadeusHotelSearchController.js";
import { GetAmadeusHotelOffers, RecordRoomOfferViewed } from "../controllers/AmadeusHotelOfferController.js";
import { VerifyAmadeusHotelPricing } from "../controllers/AmadeusHotelPricingController.js";
import { CreateAmadeusHotelBooking } from "../controllers/AmadeusHotelBookingController.js";
import { GetAmadeusHotelBooking } from "../controllers/AmadeusHotelBookingRetrievalController.js";
import { CancelAmadeusHotelBooking } from "../controllers/AmadeusHotelCancellationController.js";
import { GetAmadeusMetricsJson, GetAmadeusMetricsPrometheus } from "../controllers/AmadeusMetricsController.js";

const router = express.Router();

const limiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 100,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: "Too many requests from this IP, please try again after 10 minutes."
});

router.use(authenticateAccessToken, limiter);

// EXT-004.
router.post("/flights/book", CreateAmadeusFlightBooking);

// EXT-005.
router.post("/flights/ticket", IssueAmadeusFlightTicket);

// EXT-008.
router.get("/seat-map/:flightOrderId", GetAmadeusFlightOrderSeatMap);

// EXT-009.
router.post("/seat-selection", AssignAmadeusSeats);

// EXT-011 (EXT-010 check-in is generic/airline-specific — see
// routes/AirlineIntegrationRoutes.js).
router.get("/flights/status", GetAmadeusFlightStatus);

// EXT-012.
router.get("/flights/schedules", GetAmadeusFlightSchedules);

// EXT-015.
router.get("/flights/inspiration", GetAmadeusFlightInspiration);
router.post("/flights/inspiration/feedback", RecordInspirationFeedback);

// EXT-016.
router.post("/flights/branded-fares", GetAmadeusBrandedFares);
router.post("/flights/branded-fares/recommendation", RecordBrandedFareRecommendation);

// EXT-017.
router.post("/flights/ancillaries", GetAmadeusAncillaryServices);
router.post("/flights/ancillaries/selection", RecordAncillarySelection);

// EXT-018.
router.post("/flights/schedule-sync", TriggerFlightScheduleSync);

// EXT-019.
router.get("/hotels/search", GetAmadeusHotelSearch);
router.post("/hotels/search/view", RecordHotelViewed);

// EXT-020.
router.get("/hotels/offers", GetAmadeusHotelOffers);
router.post("/hotels/offers/view", RecordRoomOfferViewed);

// EXT-021.
router.post("/hotels/pricing", VerifyAmadeusHotelPricing);

// EXT-022. §16/§18 "Idempotency Key" — same middleware+usage pattern
// already established on TravelPlanRoutes.js/IncidentRoutes.js's own
// write endpoints, applied here since this is a real hotel reservation
// creation, opt-in via an `Idempotency-Key` request header.
router.post("/hotels/book", idempotency(), CreateAmadeusHotelBooking);

// EXT-023.
router.get("/hotels/bookings/:providerBookingId", GetAmadeusHotelBooking);

// EXT-024. §16/§18 "Idempotency Key" — same middleware+usage pattern as EXT-022.
router.post("/hotels/bookings/:providerBookingId/cancel", idempotency(), CancelAmadeusHotelBooking);

// EXT-025 §16 "Monitoring" — real counters/circuit-breaker state, never
// previously exposed via any endpoint.
router.get("/metrics", GetAmadeusMetricsJson);
router.get("/metrics/prometheus", GetAmadeusMetricsPrometheus);

export default router;
