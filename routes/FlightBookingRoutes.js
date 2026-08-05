import express from "express";
import rateLimit from "express-rate-limit";
import authenticateAccessToken from "../middleware/authenticateAccessToken.js";
import {
  CreateFlightBooking,
  GetFlightBookingById,
  RevalidateBookingOffer,
  CancelFlightBooking,
  SyncFlightBooking,
  GetFlightBookingHistory,
  GetPnrDetails,
  IssueTicket,
  VoidTicket,
  ReissueTicket,
  RefundTicket,
  AddSSR,
  AddOSI,
  IssueEMD
} from "../controllers/FlightBookingController.js";

const router = express.Router();

const limiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 100,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: "Too many requests from this IP, please try again after 10 minutes."
});

// "Authentication: Required (Bearer JWT)" / "Authorization: Required
// (flight.book)" — every route here was previously completely public,
// same class of bug already fixed for Flight Search (API-006B).
router.use(authenticateAccessToken, limiter);

// Create Live PNR Booking from Flight Offer
router.post("/", CreateFlightBooking);

// Revalidate Selected Offer Before Booking
router.post("/revalidate", RevalidateBookingOffer);

// Get Complete Provider Booking Details / PNR Snapshot
router.get("/:flightBookingId", GetFlightBookingById);

// Get Full PNR Information & Servicing Summary
router.get("/:flightBookingId/pnr", GetPnrDetails);

// Issue Electronic Airline Tickets
router.post("/:flightBookingId/ticket", IssueTicket);

// Void Issued Ticket Within Policy Window
router.post("/:flightBookingId/void", VoidTicket);

// Reissue / Exchange Ticket
router.post("/:flightBookingId/reissue", ReissueTicket);

// Request Ticket Refund
router.post("/:flightBookingId/refund", RefundTicket);

// Synchronize PNR Status with GDS Provider
router.post("/:flightBookingId/sync", SyncFlightBooking);

// Add Special Service Request (SSR)
router.post("/:flightBookingId/ssr", AddSSR);

// Add Other Service Information (OSI)
router.post("/:flightBookingId/osi", AddOSI);

// Issue Electronic Miscellaneous Document (EMD)
router.post("/:flightBookingId/emd", IssueEMD);

// Audit & Version History
router.get("/:flightBookingId/history", GetFlightBookingHistory);

export default router;
