import HotelBookingModel from "../models/HotelBookingModel.js";
import BookingHeaderModel from "../models/BookingHeaderModel.js";
import AuditLogModel from "../models/AuditLogmodel.js";
import GdsIntegrationService from "../services/GdsIntegrationService.js";
import { recordCanonicalDomainEvent } from "./TravelNotesTimelineController.js";
import { sendError, sendSuccess } from "../utils/apiResponse.js";
import { publishEvent } from "../utils/eventBus.js";
import { createRequestId } from "../utils/authTokens.js";
import { getHotelSearchValidationConfig, getFlightSearchValidationConfig } from "../utils/gdsConfig.js";

/**
 * 1. POST /api/v1/hotel-search
 * Live hotel search across GDS and hotel suppliers.
 */
export const SearchHotels = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const tenantId = req.auth?.tenantId;
    if (!tenantId) return sendError(res, 403, "Tenant context is required.", requestId);
    const permissions = req.auth?.permissions || [];
    if (!permissions.includes("hotel.search") && !permissions.includes("admin")) {
      return sendError(res, 403, "Permission denied.", requestId);
    }
    const { city, checkIn, checkOut, rooms = 1, adults = 2, children = 0, nationality = "PK", currency = "PKR", provider = "Amadeus" } = req.body;

    if (!city || !checkIn || !checkOut) {
      return sendError(res, 400, "city, checkIn, and checkOut dates are required.", requestId);
    }

    const checkInDate = new Date(checkIn);
    const checkOutDate = new Date(checkOut);
    if (Number.isNaN(checkInDate.getTime()) || Number.isNaN(checkOutDate.getTime())) {
      return sendError(res, 400, "checkIn/checkOut are not valid dates.", requestId);
    }

    // Validation Rules "Check-in Valid", "Check-out Valid", "Guests Valid",
    // "Rooms Valid", "Currency Supported" — only checkOut>checkIn was
    // previously enforced.
    const today = new Date(new Date().getFullYear(), new Date().getMonth(), new Date().getDate());
    if (checkInDate < today) {
      return sendError(res, 400, "checkIn cannot be in the past.", requestId);
    }
    if (checkOutDate <= checkInDate) {
      return sendError(res, 400, "checkOut date must be after checkIn date.", requestId);
    }
    const hotelPolicy = getHotelSearchValidationConfig();
    const maxAdvanceDate = new Date(today.getTime() + hotelPolicy.maxAdvanceBookingDays * 24 * 60 * 60 * 1000);
    if (checkInDate > maxAdvanceDate) {
      return sendError(res, 400, `checkIn cannot be more than ${hotelPolicy.maxAdvanceBookingDays} days in the future.`, requestId);
    }

    const roomsCount = Number(rooms);
    const adultsCount = Number(adults);
    const childrenCount = Number(children);
    if (!Number.isInteger(roomsCount) || roomsCount < 1 || roomsCount > hotelPolicy.maxRooms) {
      return sendError(res, 400, `rooms must be a whole number between 1 and ${hotelPolicy.maxRooms}.`, requestId);
    }
    if (!Number.isInteger(adultsCount) || adultsCount < 1) {
      return sendError(res, 400, "At least 1 adult guest is required.", requestId);
    }
    if (!Number.isInteger(childrenCount) || childrenCount < 0) {
      return sendError(res, 400, "children must be a non-negative whole number.", requestId);
    }
    if (adultsCount + childrenCount > hotelPolicy.maxGuestsPerBooking) {
      return sendError(res, 400, `Total guests cannot exceed ${hotelPolicy.maxGuestsPerBooking}.`, requestId);
    }

    const { supportedCurrencies } = getFlightSearchValidationConfig();
    if (!supportedCurrencies.includes(currency)) {
      return sendError(res, 400, `Unsupported currency '${currency}'. Must be one of: ${supportedCurrencies.join(", ")}.`, requestId);
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
    const permissions = req.auth?.permissions || [];
    if (!permissions.includes("hotel.search") && !permissions.includes("admin")) {
      return sendError(res, 403, "Permission denied.", requestId);
    }
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
    const tenantId = req.auth?.tenantId;
    if (!tenantId) return sendError(res, 403, "Tenant context is required.", requestId);
    const permissions = req.auth?.permissions || [];
    if (!permissions.includes("hotel.book") && !permissions.includes("admin")) {
      return sendError(res, 403, "Permission denied.", requestId);
    }
    const { offerId, provider = "Amadeus" } = req.body;
    if (!offerId) {
      return sendError(res, 400, "offerId is required.", requestId);
    }

    const result = await GdsIntegrationService.revalidateHotelOffer({ offerId, tenantId, provider });

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
    const tenantId = req.auth?.tenantId;
    if (!tenantId) return sendError(res, 403, "Tenant context is required.", requestId);
    const userId = req.auth?.userId || req.auth?.id;
    const permissions = req.auth?.permissions || [];
    if (!permissions.includes("hotel.book") && !permissions.includes("admin")) {
      return sendError(res, 403, "Permission denied.", requestId);
    }
    const { offerId, bookingId, travelPlanId, guests = [] } = req.body;

    if (!offerId) {
      return sendError(res, 400, "offerId is required.", requestId);
    }
    if (!Array.isArray(guests) || guests.length === 0) {
      return sendError(res, 400, "At least one guest is required.", requestId);
    }
    for (const guest of guests) {
      if (!guest.firstName || !guest.lastName) {
        return sendError(res, 400, "firstName and lastName are required for each guest.", requestId);
      }
    }

    // Business Rule "Duplicate booking prevented."
    const existingBooking = await HotelBookingModel.findOne({
      tenantId, offerId, status: { $nin: ["Cancelled"] }
    });
    if (existingBooking) {
      return sendSuccess(res, 200, "An active reservation already exists for this offer; returning the existing booking.", {
        hotelBookingId: existingBooking._id,
        reservationNumber: existingBooking.reservationNumber,
        provider: existingBooking.provider,
        status: existingBooking.status,
        hotelName: existingBooking.hotelName,
        city: existingBooking.city,
        totalPrice: existingBooking.totalPrice,
        currency: existingBooking.currency,
        idempotentReplay: true
      }, requestId);
    }

    // "Same Tenant" — a bookingId the client supplies must actually belong
    // to this tenant.
    if (bookingId) {
      const bookingHeaderExists = await BookingHeaderModel.exists({ _id: bookingId, tenantId });
      if (!bookingHeaderExists) {
        return sendError(res, 404, "bookingId does not exist for this tenant.", requestId);
      }
    }

    // Validation Rules "Offer Exists", "Offer Valid", "Rooms Available" —
    // previously never checked at all; hotelName/city/checkIn/checkOut/
    // totalPrice were silently defaulted to fabricated values ("Swissotel
    // Makkah" / fixed 2027 dates) whenever the client omitted them, meaning
    // an incomplete or buggy request would create a wrong reservation with
    // fake data instead of failing. Every one of those fields now comes
    // from the real, cache-backed revalidated offer.
    const revalidation = await GdsIntegrationService.revalidateHotelOffer({ offerId, tenantId });
    if (!revalidation.isValid) {
      return sendError(res, 400, revalidation.reason || "Hotel offer is no longer valid or fully booked.", requestId);
    }
    if (revalidation.requestedRooms && revalidation.availableRooms < revalidation.requestedRooms) {
      return sendError(res, 400, `Only ${revalidation.availableRooms} room(s) available for this offer.`, requestId);
    }
    // Validation Rule "Guest Count Valid".
    if (revalidation.requestedGuests && guests.length > revalidation.requestedGuests) {
      return sendError(res, 400, `Guest count (${guests.length}) exceeds the original search's guest count (${revalidation.requestedGuests}).`, requestId);
    }

    const resolvedProvider = revalidation.provider;
    const hotelName = revalidation.hotelName;
    const city = revalidation.city;
    const roomType = revalidation.roomType;
    const mealPlan = revalidation.mealPlan;
    const currency = revalidation.currency;
    const totalPrice = revalidation.currentPrice;
    const checkIn = req.body.checkIn;
    const checkOut = req.body.checkOut;
    if (!checkIn || !checkOut) {
      return sendError(res, 400, "checkIn and checkOut are required.", requestId);
    }
    const checkInDate = new Date(checkIn);
    const checkOutDate = new Date(checkOut);
    if (Number.isNaN(checkInDate.getTime()) || Number.isNaN(checkOutDate.getTime()) || checkOutDate <= checkInDate) {
      return sendError(res, 400, "checkIn/checkOut are invalid or checkOut is not after checkIn.", requestId);
    }

    // Call Supplier API via GDS Integration Layer
    const supplierResult = await GdsIntegrationService.createHotelBooking({
      offerId,
      provider: resolvedProvider,
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
      provider: supplierResult.provider || resolvedProvider,
      reservationNumber: supplierResult.reservationNumber,
      status: "Confirmed",
      hotelName: supplierResult.hotelName || hotelName,
      city,
      roomType: supplierResult.roomType || roomType,
      mealPlan,
      cancellationPolicy: revalidation.cancellationPolicy || undefined,
      checkIn: checkInDate,
      checkOut: checkOutDate,
      roomsCount: revalidation.requestedRooms || 1,
      guestsCount: guests.length,
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

    AuditLogModel.create({
      tenantId, userId, action: "CREATE_HOTEL_BOOKING", module: "GDSIntegration",
      targetId: hotelBooking._id.toString(), details: { reservationNumber: hotelBooking.reservationNumber, provider: hotelBooking.provider }
    }).catch((err) => console.error("Audit log error:", err));

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
    const tenantId = req.auth?.tenantId;
    if (!tenantId) return sendError(res, 403, "Tenant context is required.", requestId);
    const permissions = req.auth?.permissions || [];
    if (!permissions.includes("hotel.book") && !permissions.includes("hotel.read") && !permissions.includes("admin")) {
      return sendError(res, 403, "Permission denied.", requestId);
    }
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
    const tenantId = req.auth?.tenantId;
    if (!tenantId) return sendError(res, 403, "Tenant context is required.", requestId);
    const userId = req.auth?.userId || req.auth?.id;
    const permissions = req.auth?.permissions || [];
    if (!permissions.includes("hotel.book") && !permissions.includes("admin")) {
      return sendError(res, 403, "Permission denied.", requestId);
    }
    const { hotelBookingId } = req.params;
    const { checkIn, checkOut, roomType, mealPlan } = req.body;

    const booking = await HotelBookingModel.findOne({ _id: hotelBookingId, tenantId });
    if (!booking) {
      return sendError(res, 404, "Hotel booking not found.", requestId);
    }
    if (booking.status === "Cancelled") {
      return sendError(res, 400, "Cannot modify a cancelled reservation.", requestId);
    }

    await GdsIntegrationService.modifyHotelBooking({
      provider: booking.provider,
      reservationNumber: booking.reservationNumber,
      checkIn,
      checkOut,
      roomType,
      tenantId
    });

    // Business Rule "Price differences recalculated" — previously dates
    // could change with zero effect on totalPrice, silently under- or
    // over-charging the guest for the new stay length. Recalculates
    // proportionally from the original per-night rate (the only rate this
    // module actually has on hand without a fresh provider quote).
    const originalNights = Math.max(1, Math.round((booking.checkOut - booking.checkIn) / 86_400_000));
    const perNightRate = booking.totalPrice / originalNights;
    const previousPrice = booking.totalPrice;

    if (checkIn) booking.checkIn = new Date(checkIn);
    if (checkOut) booking.checkOut = new Date(checkOut);
    if (roomType) booking.roomType = roomType;
    if (mealPlan) booking.mealPlan = mealPlan;

    if (checkIn || checkOut) {
      const newNights = Math.max(1, Math.round((booking.checkOut - booking.checkIn) / 86_400_000));
      booking.totalPrice = Number((perNightRate * newNights).toFixed(2));
    }
    booking.status = "Modified";

    booking.version = (booking.version || 1) + 1;
    booking.versionHistory.push({
      version: booking.version,
      updatedBy: userId || "Staff",
      updatedAt: new Date(),
      changes: { ...req.body, previousPrice, newPrice: booking.totalPrice }
    });

    await booking.save();

    if (booking.travelPlanId) {
      await recordCanonicalDomainEvent({
        travelPlanId: booking.travelPlanId,
        tenantId,
        sourceModule: "GDSIntegration",
        aggregateType: "HotelBooking",
        aggregateId: booking._id,
        eventType: "HotelBookingModified",
        title: `Hotel Booking Modified: ${booking.hotelName}`,
        description: `Reservation ${booking.reservationNumber} updated. Price ${previousPrice} → ${booking.totalPrice} ${booking.currency}.`,
        actor: { userId: userId || "System", name: "Hotel Booking Desk", role: "Ops Coordinator" }
      });
    }

    publishEvent("HotelBookingModified", { hotelBookingId: booking._id, previousPrice, newPrice: booking.totalPrice, tenantId });

    AuditLogModel.create({
      tenantId, userId, action: "MODIFY_HOTEL_BOOKING", module: "GDSIntegration",
      targetId: booking._id.toString(), details: { reservationNumber: booking.reservationNumber, previousPrice, newPrice: booking.totalPrice }
    }).catch((err) => console.error("Audit log error:", err));

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
    const tenantId = req.auth?.tenantId;
    if (!tenantId) return sendError(res, 403, "Tenant context is required.", requestId);
    const userId = req.auth?.userId || req.auth?.id;
    const permissions = req.auth?.permissions || [];
    if (!permissions.includes("hotel.book") && !permissions.includes("admin")) {
      return sendError(res, 403, "Permission denied.", requestId);
    }
    const { hotelBookingId } = req.params;
    const { reason } = req.body;
    if (!reason || !String(reason).trim()) {
      return sendError(res, 400, "A cancellation reason is required.", requestId);
    }

    const booking = await HotelBookingModel.findOne({ _id: hotelBookingId, tenantId });
    if (!booking) {
      return sendError(res, 404, "Hotel booking not found.", requestId);
    }
    if (booking.status === "Cancelled") {
      return sendError(res, 400, "Hotel reservation is already cancelled.", requestId);
    }

    // Business Rule "Retrieve Cancellation Policy... Penalty calculated" —
    // the provider's cancelHotelBooking response already returns a real
    // penaltyFee/refundAmount, but it was previously discarded entirely;
    // the snapshot never recorded what the guest was actually charged or
    // refunded.
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
    booking.cancellationPenaltyFee = cancelResult.penaltyFee ?? 0;
    booking.cancellationRefundAmount = cancelResult.refundAmount ?? booking.totalPrice;

    booking.version = (booking.version || 1) + 1;
    booking.versionHistory.push({
      version: booking.version,
      updatedBy: userId || "Staff",
      updatedAt: new Date(),
      changes: { action: "CANCELLED", reason, penaltyFee: booking.cancellationPenaltyFee, refundAmount: booking.cancellationRefundAmount }
    });
    await booking.save();

    if (booking.travelPlanId) {
      await recordCanonicalDomainEvent({
        travelPlanId: booking.travelPlanId,
        tenantId,
        sourceModule: "GDSIntegration",
        aggregateType: "HotelBooking",
        aggregateId: booking._id,
        eventType: "HotelBookingCancelled",
        title: `Hotel Reservation Cancelled: ${booking.hotelName}`,
        description: `Reason: ${reason}. Penalty: ${booking.cancellationPenaltyFee} ${booking.currency}. Eligible refund: ${booking.cancellationRefundAmount} ${booking.currency} (Finance handles payout).`,
        actor: { userId: userId || "System", name: "Hotel Booking Desk", role: "Ops Coordinator" }
      });
    }

    publishEvent("HotelBookingCancelled", {
      hotelBookingId: booking._id, reservationNumber: booking.reservationNumber,
      penaltyFee: booking.cancellationPenaltyFee, refundAmount: booking.cancellationRefundAmount, tenantId
    });

    AuditLogModel.create({
      tenantId, userId, action: "CANCEL_HOTEL_BOOKING", module: "GDSIntegration",
      targetId: booking._id.toString(), details: { reservationNumber: booking.reservationNumber, reason, penaltyFee: booking.cancellationPenaltyFee, refundAmount: booking.cancellationRefundAmount }
    }).catch((err) => console.error("Audit log error:", err));

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
    const tenantId = req.auth?.tenantId;
    if (!tenantId) return sendError(res, 403, "Tenant context is required.", requestId);
    const userId = req.auth?.userId || req.auth?.id;
    const permissions = req.auth?.permissions || [];
    if (!permissions.includes("hotel.book") && !permissions.includes("admin")) {
      return sendError(res, 403, "Permission denied.", requestId);
    }
    const { hotelBookingId } = req.params;

    const booking = await HotelBookingModel.findOne({ _id: hotelBookingId, tenantId });
    if (!booking) {
      return sendError(res, 404, "Hotel booking not found.", requestId);
    }
    if (booking.status === "Cancelled") {
      return sendError(res, 400, "Cannot generate a voucher for a cancelled reservation.", requestId);
    }

    const voucherResult = await GdsIntegrationService.generateHotelVoucher({
      provider: booking.provider,
      reservationNumber: booking.reservationNumber,
      tenantId
    });

    booking.voucherNumber = voucherResult.voucherNumber;
    booking.voucherUrl = voucherResult.voucherUrl;
    await booking.save();

    if (booking.travelPlanId) {
      await recordCanonicalDomainEvent({
        travelPlanId: booking.travelPlanId,
        tenantId,
        sourceModule: "GDSIntegration",
        aggregateType: "HotelBooking",
        aggregateId: booking._id,
        eventType: "VoucherGenerated",
        title: `Voucher Generated for ${booking.hotelName}`,
        description: `Voucher ${voucherResult.voucherNumber} for reservation ${booking.reservationNumber}.`,
        actor: { userId: userId || "System", name: "Hotel Booking Desk", role: "Ops Coordinator" }
      });
    }

    publishEvent("VoucherGenerated", { hotelBookingId: booking._id, voucherNumber: voucherResult.voucherNumber, tenantId });

    AuditLogModel.create({
      tenantId, userId, action: "GENERATE_HOTEL_VOUCHER", module: "GDSIntegration",
      targetId: booking._id.toString(), details: { voucherNumber: voucherResult.voucherNumber }
    }).catch((err) => console.error("Audit log error:", err));

    // "Voucher Includes": Reservation Number, Hotel, Guests, Room Type,
    // Meal Plan, Check-in, Check-out, QR Code — all previously available on
    // the booking document but not surfaced in the response. Supplier
    // Contact / Emergency Contact are named in the doc but no real source
    // for either exists anywhere in this codebase (no supplier directory,
    // no emergency-contact model) — left out rather than fabricated.
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
        guests: booking.guests,
        roomType: booking.roomType,
        mealPlan: booking.mealPlan,
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
    const tenantId = req.auth?.tenantId;
    if (!tenantId) return sendError(res, 403, "Tenant context is required.", requestId);
    const userId = req.auth?.userId || req.auth?.id;
    const permissions = req.auth?.permissions || [];
    if (!permissions.includes("hotel.book") && !permissions.includes("admin")) {
      return sendError(res, 403, "Permission denied.", requestId);
    }
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

    // "Synchronization Includes: Reservation Status..." — previously
    // discarded the provider's real status, same bug class fixed for
    // flight bookings.
    const previousStatus = booking.status;
    if (syncResult.status && syncResult.status !== booking.status && HotelBookingModel.schema.path("status").enumValues.includes(syncResult.status)) {
      booking.status = syncResult.status;
      booking.version = (booking.version || 1) + 1;
      booking.versionHistory.push({
        version: booking.version,
        updatedBy: userId || "System",
        updatedAt: new Date(),
        changes: { action: "PROVIDER_SYNC", previousStatus, newStatus: syncResult.status }
      });
    }
    booking.lastSynchronizedAt = new Date();
    await booking.save();

    if (booking.travelPlanId && previousStatus !== booking.status) {
      await recordCanonicalDomainEvent({
        travelPlanId: booking.travelPlanId,
        tenantId,
        sourceModule: "GDSIntegration",
        aggregateType: "HotelBooking",
        aggregateId: booking._id,
        eventType: "HotelBookingSynchronized",
        title: `Reservation ${booking.reservationNumber} Synchronized`,
        description: `Status changed from ${previousStatus} to ${booking.status}.`,
        actor: { userId: userId || "System", name: "GDS Sync Worker", role: "System" }
      });
    }

    publishEvent("HotelBookingSynchronized", { hotelBookingId: booking._id, previousStatus, newStatus: booking.status, tenantId });

    AuditLogModel.create({
      tenantId, userId, action: "SYNC_HOTEL_BOOKING", module: "GDSIntegration",
      targetId: booking._id.toString(), details: { reservationNumber: booking.reservationNumber, previousStatus, newStatus: booking.status }
    }).catch((err) => console.error("Audit log error:", err));

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
    const permissions = req.auth?.permissions || [];
    if (!permissions.includes("hotel.book") && !permissions.includes("hotel.search") && !permissions.includes("admin")) {
      return sendError(res, 403, "Permission denied.", requestId);
    }
    const statusData = await GdsIntegrationService.getProviderStatus();

    return sendSuccess(res, 200, "Hotel supplier provider status retrieved successfully.", statusData, requestId);
  } catch (err) {
    console.error("GetHotelProviderStatus Error:", err);
    return sendError(res, 500, err.message || "Failed to check provider status.", requestId);
  }
};
