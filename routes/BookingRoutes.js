import express from "express";
import authenticateAccessToken from "../middleware/authenticateAccessToken.js";
import { requireFeature, subscriptionResponseHeaders } from "../middleware/subscriptionEnforcement.js";
import validate, { bookingSchemas } from "../middleware/validateRequest.js";
import rateLimit from "express-rate-limit";
import {
  ListBookings,
  SearchBookings,
  CreateBooking,
  GetBooking,
  UpdateBooking,
  ArchiveBooking,
  ConfirmBooking,
  CancelBooking,
  ListBookingTravelers,
  AddBookingTravelers,
  UpdateBookingTraveler,
  RemoveBookingTraveler,
  ListBookingServices,
  AddBookingServices,
  UpdateBookingService,
  RemoveBookingService,
  AssignTravelerServices,
  GetBookingWorkflow,
  TransitionBookingWorkflow,
  ListBookingDocuments,
  AddBookingDocument,
  VerifyBookingDocument,
  RejectBookingDocument,
  ListBookingNotes,
  AddBookingNote,
  ListBookingTimeline,
  ListBookingTasks,
  AddBookingTask,
  UpdateBookingTask,
  GetBookingFinancialSummary,
  GetBookingDashboard
} from "../controllers/BookingController.js";

const router = express.Router();
const limiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 100,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: "Too many requests from this IP, please try again after 15 minutes."
});

router.use(authenticateAccessToken);
// Enterprise Subscription Platform — see routes/FinanceRoutes.js's own doc comment.
router.use(requireFeature("booking"));
router.use(subscriptionResponseHeaders);

// Dashboard & Search
router.get("/dashboard", limiter, GetBookingDashboard);
router.get("/search", limiter, SearchBookings);

// Booking CRUD & State transitions
router.get("/", limiter, ListBookings);
router.post("/", limiter, validate(bookingSchemas.createBooking), CreateBooking);
router.get("/:bookingId", limiter, GetBooking);
router.patch("/:bookingId", limiter, validate(bookingSchemas.updateBooking), UpdateBooking);
router.post("/:bookingId/archive", limiter, ArchiveBooking);
router.post("/:bookingId/confirm", limiter, ConfirmBooking);
router.post("/:bookingId/cancel", limiter, validate(bookingSchemas.cancelBooking), CancelBooking);

// Booking Travelers APIs (Part 3)
router.get("/:bookingId/travelers", limiter, ListBookingTravelers);
router.post("/:bookingId/travelers", limiter, validate(bookingSchemas.addBookingTravelers), AddBookingTravelers);
router.patch("/:bookingId/travelers/:travelerId", limiter, validate(bookingSchemas.updateBookingTraveler), UpdateBookingTraveler);
router.delete("/:bookingId/travelers/:travelerId", limiter, RemoveBookingTraveler);

// Booking Services APIs (Part 4)
router.get("/:bookingId/services", limiter, ListBookingServices);
router.post("/:bookingId/services", limiter, validate(bookingSchemas.addBookingServices), AddBookingServices);
router.patch("/:bookingId/services/:serviceAssignmentId", limiter, validate(bookingSchemas.updateBookingService), UpdateBookingService);
router.delete("/:bookingId/services/:serviceAssignmentId", limiter, RemoveBookingService);
router.post("/:bookingId/traveler-services", limiter, AssignTravelerServices);

// Booking Workflow APIs (Part 5)
router.get("/:bookingId/workflow", limiter, GetBookingWorkflow);
router.patch("/:bookingId/workflow", limiter, validate(bookingSchemas.transitionBookingWorkflow), TransitionBookingWorkflow);

// Booking Operations APIs (Part 6)
router.get("/:bookingId/documents", limiter, ListBookingDocuments);
router.post("/:bookingId/documents", limiter, validate(bookingSchemas.addBookingDocument), AddBookingDocument);
router.post("/:bookingId/documents/:documentId/verify", limiter, VerifyBookingDocument);
router.post("/:bookingId/documents/:documentId/reject", limiter, validate(bookingSchemas.rejectBookingDocument), RejectBookingDocument);
router.get("/:bookingId/notes", limiter, ListBookingNotes);
router.post("/:bookingId/notes", limiter, validate(bookingSchemas.addBookingNote), AddBookingNote);
router.get("/:bookingId/timeline", limiter, ListBookingTimeline);
router.get("/:bookingId/tasks", limiter, ListBookingTasks);
router.post("/:bookingId/tasks", limiter, validate(bookingSchemas.addBookingTask), AddBookingTask);
router.patch("/:bookingId/tasks/:taskId", limiter, validate(bookingSchemas.updateBookingTask), UpdateBookingTask);

// Financial Summary API (Part 7)
router.get("/:bookingId/financial-summary", limiter, GetBookingFinancialSummary);

export default router;
