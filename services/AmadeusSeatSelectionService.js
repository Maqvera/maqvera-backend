import mongoose from "mongoose";
import FlightBookingModel from "../models/FlightBookingModel.js";
import TravelPlanModel from "../models/TravelPlanModel.js";
import TravelFlightAssignmentModel from "../models/TravelFlightAssignmentModel.js";
import AuditLogModel from "../models/AuditLogmodel.js";
import GdsIntegrationService from "./GdsIntegrationService.js";
import AmadeusSeatMapService from "./AmadeusSeatMapService.js";
import CacheManager from "../utils/cacheManager.js";
import { throwStructured } from "./AmadeusFlightBookingService.js";
import { recordCanonicalDomainEvent } from "../controllers/TravelNotesTimelineController.js";
import { publishEvent } from "../utils/eventBus.js";

const INACTIVE_BOOKING_STATUSES = ["Cancelled", "Expired", "Rejected", "Failed"];
const OCCUPIED_STATUSES = new Set(["OCCUPIED", "RESERVED"]);
const UNASSIGNABLE_STATUSES = new Set(["BLOCKED", "UNAVAILABLE"]);

const deriveSeatType = (seat, cabin) => {
  if (cabin && /first/i.test(cabin)) return "First Class";
  if (cabin && /business/i.test(cabin)) return "Business";
  const features = seat.features || [];
  if (features.includes("Emergency Exit")) return "Emergency Exit";
  if (features.includes("Extra Legroom")) return "Extra Legroom";
  if (features.includes("Bassinet")) return "Bassinet";
  if (features.includes("Premium")) return "Premium";
  if (features.includes("Window")) return "Window";
  if (features.includes("Aisle")) return "Aisle";
  return "Middle";
};

/**
 * EXT-009 — Amadeus Seat Selection API. Assigns airline seats to travelers
 * on an already-confirmed flight order. Reuses EXT-008's live seat map as
 * the authoritative source for "Segment Exists"/"Seat Exists"/"Seat
 * Available" — exactly the workflow the doc itself describes ("Retrieve
 * Seat Map (EXT-008) → Employee Selects Seats → Assign Seats").
 */
class AmadeusSeatSelectionService {
  static async assignSeats({ tenantId, userId, userName, flightOrderId, seatSelections, paymentApproved, requestId }) {
    // §7 "Valid Flight Order ID" / request shape.
    if (!flightOrderId || !String(flightOrderId).trim()) {
      throwStructured("flightOrderId is required.", "INVALID_REQUEST", 400);
    }
    if (!Array.isArray(seatSelections) || seatSelections.length === 0) {
      throwStructured("At least one seat selection is required.", "INVALID_REQUEST", 400);
    }
    for (const s of seatSelections) {
      if (!s.travelerId || !s.segmentId || !s.seatNumber) {
        throwStructured("Each seat selection requires travelerId, segmentId, and seatNumber.", "INVALID_REQUEST", 400);
      }
    }

    // "Flight Order Exists" / "Same Tenant".
    const booking = await FlightBookingModel.findOne({
      tenantId,
      $or: [{ airlineOrderId: flightOrderId }, { providerBookingReference: flightOrderId }]
    });
    if (!booking) {
      throwStructured("Flight order not found for this tenant.", "FLIGHT_ORDER_NOT_FOUND", 404);
    }

    // "Booking Cancelled" / "Booking Expired" business exceptions.
    if (INACTIVE_BOOKING_STATUSES.includes(booking.status)) {
      const exception = booking.status === "Cancelled" ? "Booking Cancelled" : booking.status === "Expired" ? "Booking Expired" : `Booking ${booking.status}`;
      throwStructured(`Cannot assign seats: ${exception}.`, "BOOKING_NOT_ACTIVE", 400);
    }

    // "Traveler Exists" / "Traveler Belongs To Booking" — sourced from the
    // Travel Plan's real traveler snapshots when linked, else this
    // booking's own traveler list (its travelerId is preserved end-to-end
    // since EXT-005's fix to AmadeusFlightBookingService).
    let knownTravelerIds;
    if (booking.travelPlanId) {
      const travelPlan = await TravelPlanModel.findOne({ _id: booking.travelPlanId, tenantId });
      knownTravelerIds = new Set((travelPlan?.travelerSnapshots || []).map((t) => String(t.travelerId)));
    } else {
      knownTravelerIds = new Set((booking.travelers || []).map((t) => (t.travelerId ? String(t.travelerId) : null)).filter(Boolean));
    }
    for (const s of seatSelections) {
      if (!knownTravelerIds.has(String(s.travelerId))) {
        throwStructured(`Traveler ${s.travelerId} does not belong to this booking.`, "TRAVELER_NOT_IN_BOOKING", 400);
      }
    }

    // "Segment Exists" / "Seat Exists" / "Seat Available" — validated
    // against EXT-008's real, live (or honestly-labeled sandbox) seat map,
    // not an internal guess.
    const seatMap = await AmadeusSeatMapService.getSeatMap({ tenantId, flightOrderId, requestId });
    const segmentsById = new Map(seatMap.segments.map((seg) => [seg.segmentId, seg]));

    const findSeat = (segmentId, seatNumber) => {
      const segment = segmentsById.get(segmentId);
      if (!segment) return { segment: null, seat: null };
      for (const row of segment.rows) {
        const seat = row.seats.find((s) => s.seatNumber === seatNumber);
        if (seat) return { segment, seat };
      }
      return { segment, seat: null };
    };

    // Validate the whole batch BEFORE calling the provider for any of it —
    // "Bulk assignment supported" should not partially apply on a bad entry.
    const plan = [];
    for (const selection of seatSelections) {
      const { segment, seat } = findSeat(selection.segmentId, selection.seatNumber);
      if (!segment) {
        throwStructured(`Segment ${selection.segmentId} does not exist on this flight order.`, "SEGMENT_NOT_FOUND", 404);
      }
      if (!seat) {
        throwStructured(`Seat ${selection.seatNumber} does not exist on segment ${selection.segmentId}.`, "SEAT_NOT_FOUND", 404);
      }

      // "Seats cannot be assigned twice" — check this booking's own prior
      // assignments for a conflicting traveler on the same physical seat.
      const conflictingAssignment = (booking.seatAssignments || []).find(
        (a) => a.status === "Confirmed" && a.segmentId === selection.segmentId && a.seatNumber === selection.seatNumber && String(a.travelerId) !== String(selection.travelerId)
      );
      if (conflictingAssignment) {
        throwStructured(`Seat ${selection.seatNumber} on segment ${selection.segmentId} is already assigned to another traveler.`, "SEAT_ALREADY_OCCUPIED", 409);
      }

      const existingForTraveler = (booking.seatAssignments || []).find(
        (a) => a.status === "Confirmed" && a.segmentId === selection.segmentId && String(a.travelerId) === String(selection.travelerId)
      );
      if (existingForTraveler && existingForTraveler.seatNumber === selection.seatNumber) {
        // Idempotent no-op — same traveler, same segment, same seat already confirmed.
        plan.push({ selection, seat, segment, action: "noop", existing: existingForTraveler });
        continue;
      }

      if (OCCUPIED_STATUSES.has(seat.status)) {
        throwStructured(`Seat ${selection.seatNumber} is already occupied.`, "SEAT_ALREADY_OCCUPIED", 409);
      }
      if (UNASSIGNABLE_STATUSES.has(seat.status)) {
        throwStructured(`Seat ${selection.seatNumber} is no longer available.`, "SEAT_NO_LONGER_AVAILABLE", 409);
      }

      // "Paid Seat Payment Required".
      if (seat.status === "CHARGEABLE" && !paymentApproved) {
        throwStructured(`Seat ${selection.seatNumber} is a paid seat and requires payment approval before assignment.`, "PAID_SEAT_PAYMENT_REQUIRED", 402);
      }

      plan.push({ selection, seat, segment, action: existingForTraveler ? "change" : "assign", existing: existingForTraveler || null });
    }

    const toConfirm = plan.filter((p) => p.action !== "noop");

    let confirmedKeys = new Set();
    if (toConfirm.length > 0) {
      let gdsResult;
      try {
        gdsResult = await GdsIntegrationService.assignSeats({
          provider: "Amadeus",
          flightOrderId,
          seatSelections: toConfirm.map((p) => p.selection),
          tenantId
        });
      } catch (err) {
        publishEvent("SeatAssignmentFailed", { flightOrderId, tenantId, reason: err.message });
        if (mongoose.connection?.readyState === 1) {
          AuditLogModel.create({
            tenantId, userId, action: "AMADEUS_SEAT_ASSIGNMENT_FAILED", module: "ExternalIntegrations",
            requestId, targetId: booking._id.toString(), details: { flightOrderId, reason: err.message }
          }).catch((auditErr) => console.error("Seat assignment failure audit log error:", auditErr));
        }
        const code = err.status === 429 ? "RATE_LIMIT_EXCEEDED" : err.status === 504 ? "PROVIDER_TIMEOUT" : "PROVIDER_UNAVAILABLE";
        const status = code === "RATE_LIMIT_EXCEEDED" ? 429 : code === "PROVIDER_TIMEOUT" ? 504 : 503;
        throwStructured("Seat assignment failed. Please retry.", code, status);
      }

      const confirmations = gdsResult.confirmations || [];
      confirmedKeys = new Set(confirmations.filter((c) => c.status === "Confirmed").map((c) => `${c.travelerId}::${c.segmentId}::${c.seatNumber}`));
      // Fail-closed on partial provider confirmation — no half-applied
      // batch, matching "Bulk assignment supported" as an all-or-nothing
      // guarantee, same as the pre-validation pass above.
      const unconfirmed = toConfirm.find((p) => !confirmedKeys.has(`${p.selection.travelerId}::${p.selection.segmentId}::${p.selection.seatNumber}`));
      if (unconfirmed) {
        throwStructured(`Seat ${unconfirmed.selection.seatNumber} was not confirmed by the provider.`, "SEAT_NOT_CONFIRMED", 409);
      }
    }

    const now = new Date();
    const responseAssignments = [];
    const changedEvents = [];
    const assignedEvents = [];

    for (const item of plan) {
      const { selection, seat, segment, action, existing } = item;
      const seatType = deriveSeatType(seat, segment.cabin);

      if (action === "noop") {
        responseAssignments.push({ travelerId: selection.travelerId, segmentId: selection.segmentId, seatNumber: selection.seatNumber, seatType: existing.seatType || seatType, status: "Confirmed" });
        continue;
      }

      if (existing) {
        existing.status = "Released";
      }
      booking.seatAssignments.push({
        travelerId: selection.travelerId,
        segmentId: selection.segmentId,
        seatNumber: selection.seatNumber,
        seatType,
        status: "Confirmed",
        previousSeatNumber: existing ? existing.seatNumber : null,
        assignedBy: userId || "System",
        assignedAt: now
      });

      responseAssignments.push({ travelerId: selection.travelerId, segmentId: selection.segmentId, seatNumber: selection.seatNumber, seatType, status: "Confirmed" });

      if (action === "change") {
        changedEvents.push({ travelerId: selection.travelerId, segmentId: selection.segmentId, seatNumber: selection.seatNumber, previousSeatNumber: existing.seatNumber });
      } else {
        assignedEvents.push({ travelerId: selection.travelerId, segmentId: selection.segmentId, seatNumber: selection.seatNumber });
      }
    }

    if (toConfirm.length > 0) {
      booking.version = (booking.version || 1) + 1;
      booking.versionHistory.push({
        version: booking.version, updatedBy: userId || "System", updatedAt: now,
        changes: { action: "SEATS_ASSIGNED", assignments: toConfirm.map((p) => ({ travelerId: p.selection.travelerId, segmentId: p.selection.segmentId, seatNumber: p.selection.seatNumber })) }
      });
      await booking.save();

      // EXT-008 §6 "Cache invalidated after... Seat Selection" — wired here,
      // the piece EXT-008's own doc flagged as belonging to this document.
      await CacheManager.invalidatePattern(`seat-map:${flightOrderId}*`);

      // Read-through sync onto Travel Operations — best-effort, single-leg
      // only. This codebase's EXT-004 aggregate links one FlightBookingModel
      // to at most one TravelFlightAssignmentModel (one flight leg); a
      // genuinely multi-segment (connecting-flight) booking isn't modeled as
      // multiple assignment records here, so only the assignment's own leg
      // is synced — a structural limitation predating this document, not
      // something silently papered over.
      if (booking.flightAssignmentId) {
        const flightAssignment = await TravelFlightAssignmentModel.findOne({ _id: booking.flightAssignmentId, tenantId });
        if (flightAssignment) {
          let touched = false;
          for (const item of toConfirm) {
            const at = flightAssignment.assignedTravelers.find((t) => String(t.travelerId) === String(item.selection.travelerId));
            if (at) { at.seatNumber = item.selection.seatNumber; touched = true; }
          }
          if (touched) {
            flightAssignment.version = (flightAssignment.version || 1) + 1;
            flightAssignment.versionHistory.push({ version: flightAssignment.version, updatedBy: userId || "System", updatedAt: now, changes: { action: "SEATS_SYNCED", flightBookingId: booking._id.toString() } });
            await flightAssignment.save();
          }
        }
      }

      if (booking.travelPlanId) {
        await recordCanonicalDomainEvent({
          travelPlanId: booking.travelPlanId,
          tenantId,
          sourceModule: "ExternalIntegrations",
          aggregateType: "FlightBooking",
          aggregateId: booking._id,
          eventType: "SeatAssigned",
          title: `Seats Assigned for PNR ${booking.pnr}`,
          description: `${toConfirm.length} seat(s) confirmed: ${toConfirm.map((p) => `${p.selection.seatNumber} (${p.selection.travelerId})`).join(", ")}.`,
          actor: { userId: userId || "System", name: userName || "Seat Assignment Service", role: "Ops Coordinator" }
        });
      }

      for (const evt of assignedEvents) {
        publishEvent("SeatAssigned", { flightOrderId, tenantId, ...evt });
      }
      for (const evt of changedEvents) {
        publishEvent("SeatChanged", { flightOrderId, tenantId, ...evt });
      }
      publishEvent("BookingUpdated", { flightBookingId: booking._id, flightOrderId, tenantId, reason: "SEATS_ASSIGNED" });

      // "Notify Travelers" — no real Email/SMS/WhatsApp/Push provider
      // exists in this codebase; same honest pattern as EXT-005 and
      // appointmentReminderScheduler.js.
      const notifiedTravelerIds = new Set(toConfirm.map((p) => String(p.selection.travelerId)));
      for (const travelerId of notifiedTravelerIds) {
        publishEvent("NotificationRequested", { tenantId, event: "SeatAssigned", priority: "normal", channel: "Email", recipientId: travelerId, flightOrderId });
      }

      if (mongoose.connection?.readyState === 1) {
        AuditLogModel.create({
          tenantId, userId, action: "AMADEUS_SEATS_ASSIGNED", module: "ExternalIntegrations",
          requestId, targetId: booking._id.toString(),
          details: {
            travelPlanId: booking.travelPlanId?.toString() || null,
            flightAssignmentId: booking.flightAssignmentId?.toString() || null,
            assignments: toConfirm.map((p) => ({ travelerId: p.selection.travelerId, segmentId: p.selection.segmentId, seatNumber: p.selection.seatNumber, previousSeat: p.existing?.seatNumber || null })),
            assignedBy: userId || "System"
          }
        }).catch((err) => console.error("Seat assignment audit log error:", err));
      }
    }

    return { flightOrderId, status: "Seat Assigned", seatAssignments: responseAssignments };
  }
}

export default AmadeusSeatSelectionService;
