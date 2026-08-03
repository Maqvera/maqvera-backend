import BookingHeaderModel from "../models/BookingHeaderModel.js";
import { subscribeEvent } from "../utils/eventBus.js";
import { recordTimeline } from "../controllers/CustomerController.js";

// Cross-module timeline aggregation ("The timeline aggregates events from
// multiple modules", Part 5). Booking is currently the only other module
// with a real customerId FK (BookingHeaderModel.customerId), so it is the
// only source wired here. Visa (links via travelerId, not customerId),
// Payments/Invoices, and Communication (Email/WhatsApp/SMS) have no real
// join key back to Customer yet in this codebase — wiring them would mean
// fabricating a relationship that doesn't exist, so they are intentionally
// left out until those modules add a real customerId reference.
const EVENT_DEFINITIONS = {
  BookingCreated: (payload) => ({ eventType: "booking_created", description: `Booking ${payload.bookingNumber || payload.bookingId} created` }),
  BookingConfirmed: (payload) => ({ eventType: "booking_confirmed", description: `Booking ${payload.bookingId} confirmed` }),
  BookingCancelled: (payload) => ({ eventType: "booking_cancelled", description: `Booking ${payload.bookingId} cancelled${payload.reason ? `: ${payload.reason}` : ""}` }),
  BookingStatusChanged: (payload) => ({ eventType: "booking_status_changed", description: `Booking ${payload.bookingId} status changed to ${payload.newStatus || "unknown"}` }),
  BookingArchived: (payload) => ({ eventType: "booking_archived", description: `Booking ${payload.bookingId} archived` }),
  BookingRescheduled: (payload) => ({ eventType: "booking_rescheduled", description: `Booking ${payload.bookingId} rescheduled` })
};

class CustomerTimelineEventBus {
  static initialized = false;

  static init() {
    if (this.initialized) return;
    this.initialized = true;

    for (const [domainEvent, describe] of Object.entries(EVENT_DEFINITIONS)) {
      subscribeEvent(domainEvent, async (payload) => {
        if (!payload?.bookingId || !payload?.tenantId) return;

        const booking = await BookingHeaderModel
          .findOne({ _id: payload.bookingId, tenantId: payload.tenantId })
          .select("customerId")
          .lean()
          .catch(() => null);
        if (!booking?.customerId) return;

        const { eventType, description } = describe(payload);
        await recordTimeline({
          customerId: booking.customerId,
          tenantId: payload.tenantId,
          module: "Booking",
          eventType,
          title: description,
          description,
          referenceId: payload.bookingId,
          metadata: { domainEvent }
        });
      });
    }
  }
}

export default CustomerTimelineEventBus;
