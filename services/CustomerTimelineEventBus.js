import BookingHeaderModel from "../models/BookingHeaderModel.js";
import { subscribeEvent } from "../utils/eventBus.js";
import { recordTimeline } from "../controllers/CustomerController.js";

// Cross-module timeline aggregation ("The timeline aggregates events from
// multiple modules", Part 5). Booking is currently the only other module
// with a real customerId FK (BookingHeaderModel.customerId), so its events
// need a lookup (payload only carries bookingId) — Per-Tenant Payment
// Gateway Integration's own `PaymentSucceeded`/`PaymentRefunded` events
// (published by `services/BookingPaymentService.js`) join the same way,
// via the booking they were applied to. Visa (links via travelerId, not
// customerId) and Communication (Email/WhatsApp/SMS) still have no real
// join key back to Customer, so they remain out. Finance's Accounts
// Receivable module (docs/05-api/07-finance-api.md Part 5) is the first
// Finance event source wired here — it was previously excluded for the
// same "no real customerId FK" reason, but AccountsReceivableModel now
// has one, and its events already carry customerId directly (no lookup
// needed, unlike Booking's).
const EVENT_DEFINITIONS = {
  BookingCreated: (payload) => ({ eventType: "booking_created", description: `Booking ${payload.bookingNumber || payload.bookingId} created` }),
  BookingConfirmed: (payload) => ({ eventType: "booking_confirmed", description: `Booking ${payload.bookingId} confirmed` }),
  BookingCancelled: (payload) => ({ eventType: "booking_cancelled", description: `Booking ${payload.bookingId} cancelled${payload.reason ? `: ${payload.reason}` : ""}` }),
  BookingStatusChanged: (payload) => ({ eventType: "booking_status_changed", description: `Booking ${payload.bookingId} status changed to ${payload.newStatus || "unknown"}` }),
  BookingArchived: (payload) => ({ eventType: "booking_archived", description: `Booking ${payload.bookingId} archived` }),
  BookingRescheduled: (payload) => ({ eventType: "booking_rescheduled", description: `Booking ${payload.bookingId} rescheduled` }),
  // Per-Tenant Payment Gateway Integration — real join key via
  // `payload.bookingId -> BookingHeaderModel.customerId`, the exact same
  // Booking-style lookup every event above already uses (unlike Finance's
  // own AR events below, `BookingPaymentService`'s `PaymentSucceeded`/
  // `PaymentRefunded` payloads carry `bookingId`, not `customerId`
  // directly).
  PaymentSucceeded: (payload) => ({ eventType: "payment_succeeded", description: `Payment of ${payload.amountPaid} ${payload.currency || ""} received for booking ${payload.bookingId}`.trim() }),
  PaymentRefunded: (payload) => ({ eventType: "payment_refunded", description: `Refund of ${payload.refundAmount} issued for booking ${payload.bookingId}` })
};

// Finance/AR events — payload already carries customerId, so these are
// recorded directly rather than going through the Booking-style lookup path.
const FINANCE_EVENT_DEFINITIONS = {
  ReceivableCreated: (payload) => ({ eventType: "receivable_created", description: `Receivable created for invoice ${payload.invoiceNumber} (${payload.originalAmount})`, referenceId: payload.receivableId }),
  PaymentAllocated: (payload) => ({ eventType: "payment_allocated", description: `Payment of ${payload.amount} allocated to receivable ${payload.receivableId}`, referenceId: payload.receivableId }),
  ReceivablePaid: (payload) => ({ eventType: "receivable_paid", description: `Receivable ${payload.receivableId} fully paid`, referenceId: payload.receivableId }),
  ReceivableOverdue: (payload) => ({ eventType: "receivable_overdue", description: `Receivable ${payload.invoiceNumber} is now overdue`, referenceId: payload.receivableId }),
  CollectionStarted: (payload) => ({ eventType: "collection_started", description: `Collections started for receivable ${payload.invoiceNumber} (${payload.daysOverdue} days overdue)`, referenceId: payload.receivableId }),
  ReceivableWrittenOff: (payload) => ({ eventType: "receivable_written_off", description: `Receivable ${payload.receivableId} written off (${payload.writeOffType})`, referenceId: payload.receivableId })
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

    for (const [domainEvent, describe] of Object.entries(FINANCE_EVENT_DEFINITIONS)) {
      subscribeEvent(domainEvent, async (payload) => {
        if (!payload?.customerId || !payload?.tenantId) return;

        const { eventType, description, referenceId } = describe(payload);
        await recordTimeline({
          customerId: payload.customerId,
          tenantId: payload.tenantId,
          module: "Finance",
          eventType,
          title: description,
          description,
          referenceId,
          metadata: { domainEvent }
        });
      });
    }
  }
}

export default CustomerTimelineEventBus;
