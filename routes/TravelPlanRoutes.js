import express from "express";
import authenticateAccessToken from "../middleware/authenticateAccessToken.js";
import rateLimit from "express-rate-limit";
import {
  ListTravelPlans,
  CreateTravelPlan,
  GetTravelPlan,
  UpdateTravelPlan,
  ArchiveTravelPlan,
  AddTravelPlanTravelers,
  SearchTravelPlans
} from "../controllers/TravelPlanController.js";
import { GetPrimaryDashboard } from "../controllers/TravelDashboardController.js";
import {
  ListTravelPlanFlights,
  AddTravelPlanFlights,
  UpdateTravelPlanFlight,
  AssignTravelersToFlight,
  UpdateFlightExecutionStatus,
  ReportFlightIncident
} from "../controllers/TravelFlightController.js";
import {
  ListTravelPlanHotels,
  AddTravelPlanHotels,
  UpdateTravelPlanHotel,
  AllocateRooms,
  UpdateHotelExecutionStatus,
  ReportHotelIncident
} from "../controllers/TravelHotelController.js";
import {
  ListTravelPlanTransports,
  AddTravelPlanTransport,
  AssignTravelersToTransport,
  UpdateTransportExecutionStatus,
  ReportTransportIncident
} from "../controllers/TravelTransportController.js";
import {
  ListTravelPlanItinerary,
  AddTravelPlanItinerary,
  UpdateTravelPlanActivity,
  AssignTravelersToActivity,
  UpdateActivityExecutionStatus
} from "../controllers/TravelItineraryController.js";
import {
  ListTravelPlanAttendance,
  CreateAttendanceSession,
  RecordTravelerAttendance,
  GetAttendanceDashboard
} from "../controllers/TravelAttendanceController.js";
import {
  CreateIncident
} from "../controllers/TravelIncidentController.js";
import {
  GetTravelPlanTimeline,
  CreateTravelNote
} from "../controllers/TravelNotesTimelineController.js";

const router = express.Router();

const limiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 100,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: "Too many requests from this IP, please try again after 10 minutes."
});

router.use(authenticateAccessToken);

// Dashboard & Search (Part 1 inventory) — literal paths registered before
// the "/:travelPlanId" param route below, otherwise Express would treat
// "dashboard"/"search" as a travelPlanId and route them into GetTravelPlan.
// GetPrimaryDashboard is also still reachable at the pre-existing
// /api/v1/travel/dashboard mount (server.js) — this is an additive alias
// matching the doc's literal GET /travel-plans/dashboard path, not a move.
router.get("/dashboard", limiter, GetPrimaryDashboard);
router.get("/search", limiter, SearchTravelPlans);

// Travel Plan CRUD Routes (Part 2)
router.get("/", limiter, ListTravelPlans);
router.post("/", limiter, CreateTravelPlan);
router.get("/:travelPlanId", limiter, GetTravelPlan);
router.patch("/:travelPlanId", limiter, UpdateTravelPlan);
router.post("/:travelPlanId/archive", limiter, ArchiveTravelPlan);
router.post("/:travelPlanId/travelers", limiter, AddTravelPlanTravelers);

// Flight Operations Routes (Part 3)
router.get("/:travelPlanId/flights", limiter, ListTravelPlanFlights);
router.post("/:travelPlanId/flights", limiter, AddTravelPlanFlights);
router.patch("/:travelPlanId/flights/:flightAssignmentId", limiter, UpdateTravelPlanFlight);
router.post("/:travelPlanId/flights/:flightAssignmentId/travelers", limiter, AssignTravelersToFlight);
router.patch("/:travelPlanId/flights/:flightAssignmentId/status", limiter, UpdateFlightExecutionStatus);
router.post("/:travelPlanId/flights/:flightAssignmentId/incidents", limiter, ReportFlightIncident);

// Hotel Operations Routes (Part 4)
router.get("/:travelPlanId/hotels", limiter, ListTravelPlanHotels);
router.post("/:travelPlanId/hotels", limiter, AddTravelPlanHotels);
router.patch("/:travelPlanId/hotels/:hotelAssignmentId", limiter, UpdateTravelPlanHotel);
router.post("/:travelPlanId/rooms", limiter, AllocateRooms);
router.patch("/:travelPlanId/hotels/:hotelAssignmentId/status", limiter, UpdateHotelExecutionStatus);
router.post("/:travelPlanId/hotels/:hotelAssignmentId/incidents", limiter, ReportHotelIncident);

// Transport Management Routes (Part 5)
router.get("/:travelPlanId/transport", limiter, ListTravelPlanTransports);
router.post("/:travelPlanId/transport", limiter, AddTravelPlanTransport);
router.post("/:travelPlanId/transport/:transportAssignmentId/travelers", limiter, AssignTravelersToTransport);
router.patch("/:travelPlanId/transport/:transportAssignmentId/status", limiter, UpdateTransportExecutionStatus);
router.post("/:travelPlanId/transport/:transportAssignmentId/incidents", limiter, ReportTransportIncident);

// Itinerary Management Routes (Part 6)
router.get("/:travelPlanId/itinerary", limiter, ListTravelPlanItinerary);
router.post("/:travelPlanId/itinerary", limiter, AddTravelPlanItinerary);
router.patch("/:travelPlanId/itinerary/:activityId", limiter, UpdateTravelPlanActivity);
router.post("/:travelPlanId/itinerary/:activityId/travelers", limiter, AssignTravelersToActivity);
router.patch("/:travelPlanId/itinerary/:activityId/status", limiter, UpdateActivityExecutionStatus);

// Attendance Management Routes (Part 7)
router.get("/:travelPlanId/attendance/dashboard", limiter, GetAttendanceDashboard);
router.get("/:travelPlanId/attendance", limiter, ListTravelPlanAttendance);
router.post("/:travelPlanId/attendance", limiter, CreateAttendanceSession);
router.patch("/:travelPlanId/attendance/:attendanceId", limiter, RecordTravelerAttendance);

// Incident Management Route under Travel Plan (Part 8)
router.post("/:travelPlanId/incidents", limiter, CreateIncident);

// Notes & Timeline Management Routes under Travel Plan (Part 9)
router.get("/:travelPlanId/timeline", limiter, GetTravelPlanTimeline);
router.post("/:travelPlanId/notes", limiter, CreateTravelNote);

export default router;
