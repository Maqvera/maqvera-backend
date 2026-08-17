import { subscribeEvent } from "../utils/eventBus.js";
import CommunicationPlatformService from "./CommunicationPlatformService.js";
import BookingHeaderModel from "../models/BookingHeaderModel.js";
import CustomerModel from "../models/CustomerModel.js";
import logger from "../utils/logger.js";

/**
 * Per-Tenant Payment Gateway Integration — Issue 8 (notification hook).
 * Subscribes to the real `PaymentSucceeded`/`PaymentRefunded` events
 * `services/BookingPaymentService.js` publishes, resolves the real
 * customer via the same `bookingId -> BookingHeaderModel.customerId` join
 * key `services/CustomerTimelineEventBus.js` now also uses, and sends via
 * the EXISTING, real Enterprise Communication Platform
 * (`CommunicationPlatformService.requestCommunication`) — deliberately
 * NOT a raw `nodemailer` transporter reuse/consolidation as originally
 * sketched. That platform already provides real delivery-status tracking,
 * DND/preference enforcement, and its own audit trail "for free," and
 * `CommunicationMessageModel.sourceModule` already has a real `"Booking"`
 * value — reusing it is more architecturally consistent than adding a
 * third, more primitive transporter (`controllers/Auth.js` and
 * `controllers/UserController.js` each already have their own separate
 * one) for the exact same job. WhatsApp/SMS are deliberately NOT sent
 * here — no Twilio (or equivalent) credentials/SDK exist anywhere in this
 * codebase; that is a separate, real integration decision, not attempted here.
 */
class PaymentNotificationListener {
  static initialized = false;

  static init() {
    if (this.initialized) return;
    this.initialized = true;

    subscribeEvent("PaymentSucceeded", (payload) => {
      PaymentNotificationListener._handle(payload, "succeeded").catch((error) => logger.error("PaymentSucceeded notification failed.", { error: error.message, bookingId: payload?.bookingId }));
    });
    subscribeEvent("PaymentRefunded", (payload) => {
      PaymentNotificationListener._handle(payload, "refunded").catch((error) => logger.error("PaymentRefunded notification failed.", { error: error.message, bookingId: payload?.bookingId }));
    });
  }

  static async _handle(payload, kind) {
    if (!payload?.bookingId || !payload?.tenantId) return;

    const booking = await BookingHeaderModel.findOne({ _id: payload.bookingId, tenantId: payload.tenantId }).select("customerId bookingReference bookingNumber").lean();
    if (!booking?.customerId) return;

    const customer = await CustomerModel.findOne({ _id: booking.customerId, tenantId: payload.tenantId }).select("email firstName lastName").lean();
    if (!customer?.email) {
      logger.info(`Payment ${kind} notification skipped for booking ${payload.bookingId} — customer has no email on file.`, { tenantId: payload.tenantId, bookingId: payload.bookingId });
      return;
    }

    const bookingRef = booking.bookingNumber || booking.bookingReference;
    const customerName = [customer.firstName, customer.lastName].filter(Boolean).join(" ") || "there";

    const { subject, content } = kind === "succeeded"
      ? {
          subject: `Payment Received — Booking ${bookingRef}`,
          content: `<p>Hi ${customerName},</p><p>We've received your payment of ${payload.amountPaid} ${payload.currency || ""} for booking <strong>${bookingRef}</strong>.</p>`
        }
      : {
          subject: `Refund Issued — Booking ${bookingRef}`,
          content: `<p>Hi ${customerName},</p><p>A refund of ${payload.refundAmount} has been issued for booking <strong>${bookingRef}</strong>.</p>`
        };

    await CommunicationPlatformService.requestCommunication({
      tenantId: payload.tenantId,
      sourceModule: "Booking",
      channel: "Email",
      recipient: { email: customer.email },
      subject,
      content,
      priority: "Normal"
    });
  }
}

export default PaymentNotificationListener;
