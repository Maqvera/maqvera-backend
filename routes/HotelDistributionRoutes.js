import express from "express";
import rateLimit from "express-rate-limit";
import authenticateAccessToken from "../middleware/authenticateAccessToken.js";
import {
  SearchHotels,
  GetHotelSearchById,
  RevalidateHotelOffer,
  CreateHotelBooking,
  GetHotelBookingById,
  ModifyHotelBooking,
  CancelHotelBooking,
  GenerateHotelVoucher,
  SyncHotelBooking,
  GetHotelProviderStatus
} from "../controllers/HotelDistributionController.js";

const router = express.Router();

const limiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 100,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: "Too many requests from this IP, please try again after 10 minutes."
});

// Same class of bug already fixed for Flight Search/Booking/Ticketing —
// every route here was previously completely public.
router.use(authenticateAccessToken, limiter);

// Live Hotel Search across Providers
router.post("/hotel-search", SearchHotels);

// Provider Status Check
router.get("/hotel-providers/status", GetHotelProviderStatus);

// Cached Search Lookup
router.get("/hotel-search/:searchId", GetHotelSearchById);

// Revalidate Hotel Rate & Room Availability
router.post("/hotel-search/revalidate", RevalidateHotelOffer);

// Create Live Hotel Reservation
router.post("/hotel-bookings", CreateHotelBooking);

// Get Hotel Reservation Snapshot by ID / Reservation Number
router.get("/hotel-bookings/:hotelBookingId", GetHotelBookingById);

// Modify Hotel Reservation
router.post("/hotel-bookings/:hotelBookingId/modify", ModifyHotelBooking);

// Cancel Hotel Reservation
router.post("/hotel-bookings/:hotelBookingId/cancel", CancelHotelBooking);

// Generate Accommodation Voucher & QR Code
router.post("/hotel-bookings/:hotelBookingId/voucher", GenerateHotelVoucher);

// Synchronize Reservation Status with Supplier
router.post("/hotel-bookings/:hotelBookingId/sync", SyncHotelBooking);

export default router;
