import mongoose from "mongoose";
import HotelBookingModel from "../models/HotelBookingModel.js";
import AuditLogModel from "../models/AuditLogmodel.js";
import { throwStructured } from "./AmadeusFlightBookingService.js";
import { recordCanonicalDomainEvent } from "../controllers/TravelNotesTimelineController.js";
import { publishEvent } from "../utils/eventBus.js";

/**
 * EXT-024 — Amadeus Hotel Booking Cancellation.
 *
 * Honest gap, same category as EXT-023's retrieval finding: Amadeus's real
 * Hotel Booking API is create-only in the public Self-Service catalog —
 * there is no documented live cancel/DELETE operation to call, unlike
 * flights (which have a real Flight Order Management cancel). Fabricating
 * a call to an unconfirmed URL would be worse than not calling it.
 *
 * "Provider cancellation rules always apply" (§11) is honored by using the
 * REAL cancellation-policy data captured at booking time (EXT-022, itself
 * sourced from EXT-021's real pricing verification, itself derived from
 * Amadeus's real `policies.cancellations[]`) to compute refund eligibility
 * and penalty — genuine computation over genuine stored data, never a
 * fabricated live provider round-trip. §3's own "Not Responsible For:
 * Payment Refund Processing" already scopes real money movement out of
 * this document entirely — this only determines WHAT the refund/penalty
 * should be, per the Enterprise Design Decision separating Booking from
 * Finance/Payments.
 */
class AmadeusHotelCancellationService {
  static async cancelBooking({ tenantId, userId, userName, providerBookingId, reason, requestId }) {
    // §9 "Validate Permission" happens in the controller; here: input shape.
    if (!providerBookingId) {
      throwStructured("providerBookingId is required.", "INVALID_REQUEST", 400);
    }
    // §11 "Cancellation reason required".
    if (!reason || typeof reason !== "string" || reason.trim().length === 0) {
      throwStructured("A cancellation reason is required.", "INVALID_REQUEST", 400);
    }

    // §10 "Booking Exists" / "Tenant Authorized" / "Booking Accessible" —
    // same tenant-scoped lookup pattern as EXT-023.
    const booking = await HotelBookingModel.findOne({ tenantId, providerConfirmationNumber: providerBookingId });
    if (!booking) {
      throwStructured("No hotel booking found for this confirmation number.", "BOOKING_NOT_FOUND", 404);
    }

    // §10 "Booking Not Already Cancelled".
    if (booking.status === "Cancelled") {
      publishEvent("HotelCancellationRejected", { tenantId, userId, hotelBookingId: booking._id, providerBookingId, reason: "Already cancelled" });
      throwStructured("This booking has already been cancelled.", "ALREADY_CANCELLED", 409);
    }
    // §10 "Booking Confirmed" — only a Confirmed booking can be cancelled
    // through this flow (e.g. not one still Pending Validation).
    if (booking.status !== "Confirmed") {
      publishEvent("HotelCancellationRejected", { tenantId, userId, hotelBookingId: booking._id, providerBookingId, reason: `Booking status is '${booking.status}', not 'Confirmed'` });
      throwStructured(`This booking cannot be cancelled from its current status ('${booking.status}').`, "CANCELLATION_NOT_ALLOWED", 409);
    }
    // §10 "Cancellation Allowed" — a stay that has already started/passed
    // cannot be meaningfully cancelled through this flow.
    if (booking.checkIn && booking.checkIn.getTime() <= Date.now()) {
      publishEvent("HotelCancellationRejected", { tenantId, userId, hotelBookingId: booking._id, providerBookingId, reason: "Check-in date has already passed" });
      throwStructured("This booking's check-in date has already passed and cannot be cancelled through this flow.", "CANCELLATION_NOT_ALLOWED", 409);
    }

    // §2 "Validate Cancellation Policy" / "Calculate Refund" — §13's real
    // outcomes, computed from the structured fields EXT-022 stored (see
    // HotelBookingModel's own note on where they come from).
    const { refundEligible, penaltyAmount, refundAmount } = AmadeusHotelCancellationService._computeRefund(booking);

    // No live provider call exists for this operation (see class doc) —
    // the cancellation itself is this internal state transition, which is
    // the real, honest analog to "Call Amadeus" (§9) given the confirmed
    // absence of a real endpoint.
    booking.status = "Cancelled";
    booking.cancellationReason = reason;
    booking.cancellationPenaltyFee = penaltyAmount;
    booking.cancellationRefundAmount = refundAmount;
    booking.cancelledAt = new Date();
    booking.cancelledBy = userId || "System";
    booking.version = (booking.version || 1) + 1;
    booking.versionHistory.push({ version: booking.version, updatedBy: userId || "System", updatedAt: new Date(), changes: { action: "HOTEL_BOOKING_CANCELLED", reason, penaltyAmount, refundAmount } });
    await booking.save();

    if (booking.travelPlanId) {
      await recordCanonicalDomainEvent({
        travelPlanId: booking.travelPlanId, tenantId, sourceModule: "ExternalIntegrations",
        aggregateType: "HotelBooking", aggregateId: booking._id, eventType: "HotelBookingCancelled",
        title: `Hotel Reservation Cancelled: ${providerBookingId}`,
        description: `${booking.hotelName} cancelled. Reason: ${reason}. ${refundEligible ? `Refund-eligible: ${refundAmount} ${booking.currency}.` : "Not refund-eligible."}`,
        actor: { userId: userId || "System", name: userName || "Hotel Cancellation Service", role: "Ops Coordinator" }
      });
    }

    publishEvent("HotelBookingCancelled", { hotelBookingId: booking._id, tenantId, providerBookingId, reason });
    publishEvent("HotelCancellationConfirmed", { hotelBookingId: booking._id, tenantId, providerBookingId, refundEligible, penaltyAmount, refundAmount });
    publishEvent("BookingStatusChanged", { hotelBookingId: booking._id, tenantId, previousStatus: "Confirmed", newStatus: "Cancelled" });
    if (booking.travelPlanId) {
      publishEvent("TravelPlanHotelCancelled", { hotelBookingId: booking._id, travelPlanId: booking.travelPlanId, tenantId });
    }
    publishEvent("TimelineEventCreated", { hotelBookingId: booking._id, tenantId, eventType: "HotelBookingCancelled" });

    if (mongoose.connection?.readyState === 1) {
      AuditLogModel.create({
        tenantId, userId, action: "AMADEUS_HOTEL_BOOKING_CANCELLED", module: "ExternalIntegrations",
        requestId, targetId: booking._id.toString(), details: { providerBookingId, reason, refundEligible, penaltyAmount, refundAmount }
      }).catch((err) => console.error("Hotel cancellation audit log error:", err));
    }

    return {
      bookingId: booking.reservationNumber,
      providerBookingId,
      status: "Cancelled",
      refundEligible,
      penaltyAmount,
      currency: booking.currency,
      refundAmount
    };
  }

  /**
   * §13 "Cancellation Outcomes" — computed from real, structured data
   * captured at booking time, never guessed:
   *   - Still within the free-cancellation window -> full refund, no penalty.
   *   - Past the window but a real penalty amount is known -> that real
   *     amount is deducted (§13 "Late Cancellation -> Penalty Applied").
   *   - Never had a free-cancellation window at all -> no refund, the
   *     full price is the effective penalty (§13 "No Refund").
   *   - Past the window with NO known real penalty amount -> refund
   *     amount is honestly `null` (not guessed as some percentage) —
   *     genuinely unknown pending manual verification against the
   *     provider's own policy text, safer than fabricating a number
   *     attached to a real refund decision.
   */
  static _computeRefund(booking) {
    const now = new Date();
    const withinFreeCancellation = Boolean(booking.refundable) && booking.freeCancellationUntilDate && now <= booking.freeCancellationUntilDate;

    if (withinFreeCancellation) {
      return { refundEligible: true, penaltyAmount: 0, refundAmount: booking.totalPrice };
    }
    if (!booking.refundable) {
      return { refundEligible: false, penaltyAmount: booking.totalPrice, refundAmount: 0 };
    }
    // Refundable in principle, but past the free-cancellation deadline.
    if (booking.cancellationPenaltyAmount != null) {
      const penalty = Math.min(booking.cancellationPenaltyAmount, booking.totalPrice);
      return { refundEligible: penalty < booking.totalPrice, penaltyAmount: penalty, refundAmount: Math.max(0, booking.totalPrice - penalty) };
    }
    return { refundEligible: false, penaltyAmount: null, refundAmount: null };
  }
}

export default AmadeusHotelCancellationService;
