import BookingHeaderModel from "../models/BookingHeaderModel.js";
import { publishEvent } from "../utils/eventBus.js";
import { executeWorkflowTransition } from "../utils/WorkflowEngine.js";
import logger from "../utils/logger.js";

const round2 = (value) => Math.round((Number(value) || 0) * 100) / 100;

/**
 * Per-Tenant Payment Gateway Integration — Issue 6. The real "Invoice
 * Paid -> Booking Confirmed -> Balance Updated -> Notification" chokepoint
 * every real Stripe `payment_intent.succeeded`/`charge.refunded` webhook
 * event (Issue 5) calls into. Never trusts a `bookingId` without the real
 * `tenantId` filter — the same tenant-isolation discipline
 * `utils/accessScope.js` already establishes everywhere else in this
 * codebase, critical here since the caller is an external webhook, not an
 * authenticated request.
 */
class BookingPaymentService {
  /** A booking can receive multiple partial payments — `amountPaid` is always ADDED, never a replacement. */
  static async markPaid({ tenantId, bookingId, amountPaid, currency, stripePaymentIntentId, performedBy = "system" }) {
    if (!tenantId) throw new Error("tenantId is required.");
    const booking = await BookingHeaderModel.findOne({ _id: bookingId, tenantId });
    if (!booking) throw new Error("Booking not found.");

    const paidDelta = round2(amountPaid);
    const totalAmount = booking.financialSnapshot.totalAmount || booking.totalAmount || 0;

    booking.paidAmount = round2((booking.paidAmount || 0) + paidDelta);
    booking.financialSnapshot.paidAmount = round2((booking.financialSnapshot.paidAmount || 0) + paidDelta);
    booking.financialSnapshot.outstandingBalance = round2(totalAmount - booking.financialSnapshot.paidAmount);

    const newStatus = booking.financialSnapshot.outstandingBalance <= 0 ? "fully_paid" : "partially_paid";
    booking.paymentStatus = newStatus;
    booking.financialSnapshot.paymentStatus = newStatus;
    booking.financialSnapshot.lastCalculatedAt = new Date();
    await booking.save();

    publishEvent("PaymentSucceeded", { tenantId, bookingId: booking._id.toString(), amountPaid: paidDelta, currency: currency || booking.currency, stripePaymentIntentId, paymentStatus: newStatus, performedBy });
    logger.info(`Booking ${booking._id} payment recorded.`, { tenantId, bookingId: booking._id.toString(), amountPaid: paidDelta, paymentStatus: newStatus });

    // Real workflow fit — booking confirmation is a `utils/WorkflowEngine.js`
    // concern, never a status flip bypassing it. Only the one genuinely
    // unambiguous case is attempted: a `reserved` booking receiving
    // payment sufficient to fully cover it is exactly what "Confirm
    // Booking" means in this codebase's own real state machine
    // (`utils/bookingConfig.js#workflowTransitions`). Any OTHER current
    // workflow state (already `confirmed`, `deposit_received`, ...) has
    // no single unambiguous "payment arrived" action defined anywhere in
    // this codebase's real config — guessing one would fabricate business
    // logic the PRD never actually specifies. A not-applicable or failed
    // attempt here must never undo the real financial update above.
    if (newStatus === "fully_paid") {
      try {
        await executeWorkflowTransition({
          tenantId, entityType: "Booking", entityId: booking._id, action: "Confirm Booking",
          performedBy, performedByName: "Stripe Webhook", userRoles: ["admin"],
          comments: "Automatically confirmed — full payment received via Stripe."
        });
      } catch (error) {
        logger.info(`Booking ${booking._id} payment recorded but no applicable workflow transition: ${error.message}`, { tenantId, bookingId: booking._id.toString() });
      }
    }

    return booking.toJSON();
  }

  /** Mirrors `markPaid` for the refund side. `Math.max(0, ...)` guards against a malformed/duplicate refund event ever pushing recorded amounts negative. */
  static async markRefunded({ tenantId, bookingId, refundAmount, stripeChargeId, performedBy = "system" }) {
    if (!tenantId) throw new Error("tenantId is required.");
    const booking = await BookingHeaderModel.findOne({ _id: bookingId, tenantId });
    if (!booking) throw new Error("Booking not found.");

    const refundDelta = round2(refundAmount);
    const totalAmount = booking.financialSnapshot.totalAmount || booking.totalAmount || 0;

    booking.financialSnapshot.refundAmount = round2((booking.financialSnapshot.refundAmount || 0) + refundDelta);
    booking.financialSnapshot.paidAmount = Math.max(0, round2((booking.financialSnapshot.paidAmount || 0) - refundDelta));
    booking.paidAmount = Math.max(0, round2((booking.paidAmount || 0) - refundDelta));
    booking.financialSnapshot.outstandingBalance = round2(totalAmount - booking.financialSnapshot.paidAmount);

    const fullyRefunded = totalAmount > 0 && booking.financialSnapshot.refundAmount >= totalAmount;
    const newStatus = fullyRefunded ? "refunded" : (booking.financialSnapshot.outstandingBalance <= 0 ? "fully_paid" : "partially_paid");
    booking.paymentStatus = newStatus;
    booking.financialSnapshot.paymentStatus = newStatus;
    booking.financialSnapshot.lastCalculatedAt = new Date();
    await booking.save();

    publishEvent("PaymentRefunded", { tenantId, bookingId: booking._id.toString(), refundAmount: refundDelta, stripeChargeId, paymentStatus: newStatus, performedBy });
    logger.info(`Booking ${booking._id} refund recorded.`, { tenantId, bookingId: booking._id.toString(), refundAmount: refundDelta, paymentStatus: newStatus });

    return booking.toJSON();
  }
}

export default BookingPaymentService;
