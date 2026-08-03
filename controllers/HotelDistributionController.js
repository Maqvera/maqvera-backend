import HotelBookingModel from "../models/HotelBookingModel.js";
import BookingHeaderModel from "../models/BookingHeaderModel.js";
import AuditLogModel from "../models/AuditLogmodel.js";
import GdsIntegrationService from "../services/GdsIntegrationService.js";
import { recordCanonicalDomainEvent } from "./TravelNotesTimelineController.js";
import { sendError, sendSuccess } from "../utils/apiResponse.js";
import { publishEvent } from "../utils/eventBus.js";
import { createRequestId } from "../utils/authTokens.js";

/**
 * 1. POST /api/v1/hotel-search
 * Live hotel search across GDS and hotel suppliers.
 */
export const SearchHotels = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const tenantId = req.auth?.tenantId || "default";
    const { city, checkIn, checkOut, rooms = 1, adults = 2, children = 0, nationality = "PK", currency = "PKR", provider = "Amadeus" } = req.body;

    if (!city || !checkIn || !checkOut) {
      return sendError(res, 400, "city, checkIn, and checkOut dates are required.", requestId);
    }

    const checkInDate = new Date(checkIn);
    const checkOutDate = new Date(checkOut);

    if (checkOutDate <= checkInDate) {
      return sendError(res, 400, "checkOut date must be after checkIn date.", requestId);
    }

    const searchResponse = await GdsIntegrationService.searchHotels({
      tenantId,
      city,
      checkIn,
      checkOut,
      rooms: Number(rooms),
      adults: Number(adults),
      children: Number(children),
      nationality,
      currency,
      provider
    });

    return sendSuccess(res, 200, "Live hotel search completed successfully.", searchResponse, requestId);
  } catch (err) {
    console.error("SearchHotels Controller Error:", err);
    return sendError(res, 500, err.message || "Failed to search live hotels.", requestId);
  }
};

/**
 * 2. GET /api/v1/hotel-search/:searchId
 * Returns cached hotel search results by ID.
 */
export const GetHotelSearchById = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const { searchId } = req.params;
    const searchData = await GdsIntegrationService.getSearchById(searchId);

    if (!searchData) {
      return sendError(res, 404, "Hotel search results expired or not found.", requestId);
    }

    return sendSuccess(res, 200, "Cached hotel search results retrieved successfully.", searchData, requestId);
  } catch (err) {
    console.error("GetHotelSearchById Error:", err);
    return sendError(res, 500, err.message || "Failed to retrieve hotel search results.", requestId);
  }
};

/**
 * 3. POST /api/v1/hotel-search/revalidate
 * Rate & availability revalidation before booking.
 */
export const RevalidateHotelOffer = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const { offerId, provider = "Amadeus", price } = req.body;
    if (!offerId) {
      return sendError(res, 400, "offerId is required.", requestId);
    }

    const result = await GdsIntegrationService.revalidateHotelOffer({ offerId, provider, price });

    return sendSuccess(res, 200, "Hotel offer revalidated successfully.", result, requestId);
  } catch (err) {
    console.error("RevalidateHotelOffer Error:", err);
    return sendError(res, 500, err.message || "Failed to revalidate hotel offer.", requestId);
  }
};

/**
 * 4. POST /api/v1/hotel-bookings
 * Create live hotel reservation with supplier.
 */
export const CreateHotelBooking = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const tenantId = req.auth?.tenantId || "default";
    const userId = req.auth?.userId || req.auth?.id;
    const {
      offerId,
      bookingId,
      travelPlanId,
      provider = "Hotelbeds",
      hotelName = "Swissotel Makkah",
      city = "Makkah",
      checkIn = "2027-01-15",
      checkOut = "2027-01-20",
      roomType = "Quad Room",
      mealPlan = "Breakfast Included",
      totalPrice = 350000,
      currency = "PKR",
      guests = []
    } = req.body;

    if (!offerId) {
      return sendError(res, 400, "offerId is required.", requestId);
    }

    if (!Array.isArray(guests) || guests.length === 0) {
      return sendError(res, 400, "At least one guest is required.", requestId);
    }

    // Call Supplier API via GDS Integration Layer
    const supplierResult = await GdsIntegrationService.createHotelBooking({
      offerId,
      provider,
      hotelName,
      roomType,
      totalPrice,
      currency,
      guests,
      tenantId
    });

    const hotelBooking = await HotelBookingModel.create({
      tenantId,
      bookingId: bookingId || null,
      travelPlanId: travelPlanId || null,
      offerId,
      provider: supplierResult.provider || provider,
      reservationNumber: supplierResult.reservationNumber,
      status: "Confirmed",
      hotelName: supplierResult.hotelName || hotelName,
      city,
      roomType: supplierResult.roomType || roomType,
      mealPlan,
      checkIn: new Date(checkIn),
      checkOut: new Date(checkOut),
      guests: guests.map((g, idx) => ({
        firstName: g.firstName,
        lastName: g.lastName,
        isLeadGuest: idx === 0
      })),
      totalPrice: supplierResult.totalPrice || totalPrice,
      currency,
      version: 1,
      versionHistory: [
        {
          version: 1,
          updatedBy: userId || "Staff",
          updatedAt: new Date(),
          changes: { action: "RESERVATION_CREATED", reservationNumber: supplierResult.reservationNumber }
        }
      ]
    });

    if (travelPlanId) {
      await recordCanonicalDomainEvent({
        travelPlanId,
        tenantId,
        sourceModule: "GDSIntegration",
        aggregateType: "HotelBooking",
        aggregateId: hotelBooking._id,
        eventType: "HotelBooked",
        title: `Hotel Confirmed: ${hotelBooking.hotelName}`,
        description: `Reservation ${hotelBooking.reservationNumber} confirmed at ${hotelName} (${city}).`,
        actor: { userId: userId || "System", name: "Hotel Booking Desk", role: "Ops Coordinator" }
      });
    }

    publishEvent("HotelBooked", {
      hotelBookingId: hotelBooking._id,
      reservationNumber: hotelBooking.reservationNumber,
      tenantId
    });

    return sendSuccess(
      res,
      201,
      "Hotel reservation confirmed successfully.",
      {
        hotelBookingId: hotelBooking._id,
        reservationNumber: hotelBooking.reservationNumber,
        provider: hotelBooking.provider,
        status: hotelBooking.status,
        hotelName: hotelBooking.hotelName,
        city: hotelBooking.city,
        totalPrice: hotelBooking.totalPrice,
        currency: hotelBooking.currency
      },
      requestId
    );
  } catch (err) {
    console.error("CreateHotelBooking Error:", err);
    return sendError(res, 500, err.message || "Failed to create hotel booking.", requestId);
  }
};

/**
 * 5. GET /api/v1/hotel-bookings/:hotelBookingId
 * Get supplier hotel reservation snapshot.
 */
export const GetHotelBookingById = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const tenantId = req.auth?.tenantId || "default";
    const { hotelBookingId } = req.params;

    const booking = await HotelBookingModel.findOne({
      $or: [
        { _id: hotelBookingId.length === 24 ? hotelBookingId : null },
        { reservationNumber: hotelBookingId }
      ],
      tenantId
    });

    if (!booking) {
      return sendError(res, 404, "Hotel reservation not found.", requestId);
    }

    return sendSuccess(res, 200, "Hotel booking details retrieved successfully.", booking, requestId);
  } catch (err) {
    console.error("GetHotelBookingById Error:", err);
    return sendError(res, 500, err.message || "Failed to retrieve hotel booking.", requestId);
  }
};

/**
 * 6. POST /api/v1/hotel-bookings/:hotelBookingId/modify
 * Modify check-in/out, guests, room type.
 */
export const ModifyHotelBooking = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const tenantId = req.auth?.tenantId || "default";
    const userId = req.auth?.userId || req.auth?.id;
    const { hotelBookingId } = req.params;
    const { checkIn, checkOut, roomType, mealPlan } = req.body;

    const booking = await HotelBookingModel.findOne({ _id: hotelBookingId, tenantId });
    if (!booking) {
      return sendError(res, 404, "Hotel booking not found.", requestId);
    }

    await GdsIntegrationService.modifyHotelBooking({
      provider: booking.provider,
      reservationNumber: booking.reservationNumber,
      checkIn,
      checkOut,
      roomType,
      tenantId
    });

    if (checkIn) booking.checkIn = new Date(checkIn);
    if (checkOut) booking.checkOut = new Date(checkOut);
    if (roomType) booking.roomType = roomType;
    if (mealPlan) booking.mealPlan = mealPlan;
    booking.status = "Modified";

    booking.version = (booking.version || 1) + 1;
    booking.versionHistory.push({
      version: booking.version,
      updatedBy: userId || "Staff",
      updatedAt: new Date(),
      changes: req.body
    });

    await booking.save();

    publishEvent("HotelBookingModified", { hotelBookingId: booking._id, tenantId });

    return sendSuccess(res, 200, "Hotel booking modified successfully.", booking, requestId);
  } catch (err) {
    console.error("ModifyHotelBooking Error:", err);
    return sendError(res, 500, err.message || "Failed to modify hotel booking.", requestId);
  }
};

/**
 * 7. POST /api/v1/hotel-bookings/:hotelBookingId/cancel
 * Cancel hotel reservation with provider.
 */
export const CancelHotelBooking = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const tenantId = req.auth?.tenantId || "default";
    const userId = req.auth?.userId || req.auth?.id;
    const { hotelBookingId } = req.params;
    const { reason = "Guest requested cancellation" } = req.body;

    const booking = await HotelBookingModel.findOne({ _id: hotelBookingId, tenantId });
    if (!booking) {
      return sendError(res, 404, "Hotel booking not found.", requestId);
    }

    const cancelResult = await GdsIntegrationService.cancelHotelBooking({
      provider: booking.provider,
      reservationNumber: booking.reservationNumber,
      totalPrice: booking.totalPrice,
      tenantId
    });

    booking.status = "Cancelled";
    booking.cancellationReason = reason;
    booking.cancelledAt = new Date();
    booking.cancelledBy = userId || "Staff";

    booking.version = (booking.version || 1) + 1;
    await booking.save();

    publishEvent("HotelBookingCancelled", { hotelBookingId: booking._id, reservationNumber: booking.reservationNumber, tenantId });

    return sendSuccess(res, 200, "Hotel reservation cancelled successfully.", { booking, cancelResult }, requestId);
  } catch (err) {
    console.error("CancelHotelBooking Error:", err);
    return sendError(res, 500, err.message || "Failed to cancel hotel booking.", requestId);
  }
};

/**
 * 8. POST /api/v1/hotel-bookings/:hotelBookingId/voucher
 * Generate hotel accommodation voucher & QR code.
 */
export const GenerateHotelVoucher = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const tenantId = req.auth?.tenantId || "default";
    const { hotelBookingId } = req.params;

    const booking = await HotelBookingModel.findOne({ _id: hotelBookingId, tenantId });
    if (!booking) {
      return sendError(res, 404, "Hotel booking not found.", requestId);
    }

    const voucherResult = await GdsIntegrationService.generateHotelVoucher({
      provider: booking.provider,
      reservationNumber: booking.reservationNumber,
      tenantId
    });

    booking.voucherNumber = voucherResult.voucherNumber;
    booking.voucherUrl = voucherResult.voucherUrl;
    await booking.save();

    publishEvent("VoucherGenerated", { hotelBookingId: booking._id, voucherNumber: voucherResult.voucherNumber, tenantId });

    return sendSuccess(
      res,
      200,
      "Hotel accommodation voucher generated successfully.",
      {
        voucherNumber: voucherResult.voucherNumber,
        voucherUrl: voucherResult.voucherUrl,
        qrCodeData: voucherResult.qrCodeData,
        reservationNumber: booking.reservationNumber,
        hotelName: booking.hotelName,
        checkIn: booking.checkIn,
        checkOut: booking.checkOut
      },
      requestId
    );
  } catch (err) {
    console.error("GenerateHotelVoucher Error:", err);
    return sendError(res, 500, err.message || "Failed to generate hotel voucher.", requestId);
  }
};

/**
 * 9. POST /api/v1/hotel-bookings/:hotelBookingId/sync
 * Synchronize hotel reservation status with provider.
 */
export const SyncHotelBooking = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const tenantId = req.auth?.tenantId || "default";
    const { hotelBookingId } = req.params;

    const booking = await HotelBookingModel.findOne({ _id: hotelBookingId, tenantId });
    if (!booking) {
      return sendError(res, 404, "Hotel booking not found.", requestId);
    }

    const syncResult = await GdsIntegrationService.syncHotelBooking({
      provider: booking.provider,
      reservationNumber: booking.reservationNumber,
      tenantId
    });

    booking.lastSynchronizedAt = new Date();
    await booking.save();

    publishEvent("HotelBookingSynchronized", { hotelBookingId: booking._id, tenantId });

    return sendSuccess(res, 200, "Hotel booking synchronized with provider successfully.", { booking, syncResult }, requestId);
  } catch (err) {
    console.error("SyncHotelBooking Error:", err);
    return sendError(res, 500, err.message || "Failed to sync hotel booking.", requestId);
  }
};

/**
 * 10. GET /api/v1/hotel-providers/status
 * Provider status & circuit health.
 */
export const GetHotelProviderStatus = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const statusData = await GdsIntegrationService.getProviderStatus();

    return sendSuccess(res, 200, "Hotel supplier provider status retrieved successfully.", statusData, requestId);
  } catch (err) {
    console.error("GetHotelProviderStatus Error:", err);
    return sendError(res, 500, err.message || "Failed to check provider status.", requestId);
  }
};
