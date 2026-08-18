import BookingHeaderModel from "../models/BookingHeaderModel.js";
import CustomerModel from "../models/CustomerModel.js";
import AccountsReceivableModel from "../models/AccountsReceivableModel.js";
import InvoiceService from "./InvoiceService.js";
import AccountsReceivableService from "./AccountsReceivableService.js";
import PaymentService from "./PaymentService.js";
import { subscribeEvent } from "../utils/eventBus.js";
import logger from "../utils/logger.js";

const roundCurrency = (value) => Math.round((Number(value) || 0) * 100) / 100;
const TERMINAL_RECEIVABLE_STATUSES = new Set(["Paid", "Settled", "Written Off", "Cancelled"]);
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Booking <-> Finance bridge (fixes the "Booking never writes Finance
 * records" gap tracked in the booking-module PRD, item #6). Booking creates
 * no Finance records directly — per CLAUDE.md, cross-context communication
 * goes through the event bus, not direct writes to another context's
 * collections — so this listens for the events BookingController/
 * BookingPaymentService already publish (BookingCreated, PaymentSucceeded)
 * and drives the real Invoice -> AccountsReceivable machinery
 * (InvoiceService/AccountsReceivableService) on Booking's behalf, the same
 * way AccountsReceivableService itself already listens for InvoiceCreated.
 *
 * Every handler here is best-effort: a Finance-side failure (unconfigured
 * tenant, closed accounting period, bad customer data) is logged and
 * swallowed, never allowed to undo or block the booking/payment that
 * already genuinely happened — matching every other event-bus listener's
 * contract in this codebase (utils/eventBus.js already isolates listener
 * failures via Promise.allSettled).
 *
 * Scope note: only the booking's CREATION amount is billed here. A booking
 * whose totalAmount changes later (via UpdateBooking) does not re-issue or
 * amend its invoice — that would require real invoice-versioning/credit-note
 * rules this codebase's requirements haven't specified yet (see the PRD's
 * "document snapshot vs live data" open question). A booking created with
 * $0 gets no invoice at all; if it's later given a real amount, it still
 * won't retroactively get one — deliberately deferred rather than guessed.
 */
class BookingFinanceLinkService {
  static _initialized = false;

  static initEventListeners() {
    if (BookingFinanceLinkService._initialized) return;
    BookingFinanceLinkService._initialized = true;

    subscribeEvent("BookingCreated", (payload) => BookingFinanceLinkService._handleBookingCreated(payload));
    subscribeEvent("PaymentSucceeded", (payload) => BookingFinanceLinkService._handlePaymentSucceeded(payload));
  }

  /**
   * Issues a real Invoice (Draft -> Approved -> Issued) for the booking's
   * package price, which — via InvoiceService.issueInvoice's own
   * InvoiceCreated publish — triggers AccountsReceivableService's existing
   * (previously dormant) listener to create the matching Receivable, and
   * posts the Debit-AR/Credit-Revenue journal when the tenant has revenue/AR
   * account codes configured. The resulting invoiceId/invoiceNumber is
   * written back onto the booking so later payments can find the receivable
   * again (see _handlePaymentSucceeded) and so a future Account Statement
   * feature has a real reference to join against.
   */
  static async _handleBookingCreated({ bookingId, tenantId }) {
    if (!bookingId || !tenantId) return;
    try {
      const booking = await BookingHeaderModel.findOne({ _id: bookingId, tenantId });
      if (!booking) return;

      const amount = roundCurrency(booking.financialSnapshot?.totalAmount || booking.totalAmount || 0);
      if (amount <= 0) return; // nothing to bill yet

      const customer = await CustomerModel.findOne({ _id: booking.customerId, tenantId }).lean();
      if (!customer) return;

      const issueDate = new Date();
      const dueDate = booking.travelDate && booking.travelDate.getTime() > issueDate.getTime()
        ? booking.travelDate
        : new Date(issueDate.getTime() + 7 * MS_PER_DAY);

      const invoice = await InvoiceService.createInvoice({
        customerId: booking.customerId,
        currency: booking.currency || "USD",
        issueDate,
        dueDate,
        items: [{ description: `Booking ${booking.bookingNumber}`, quantity: 1, unitPrice: amount }],
        notes: `Auto-generated for booking ${booking.bookingNumber}.`
      }, tenantId, "system");

      await InvoiceService.approveInvoice(invoice._id, tenantId, "system");
      const issued = await InvoiceService.issueInvoice(invoice._id, tenantId, "system");

      await BookingHeaderModel.updateOne(
        { _id: booking._id, tenantId },
        { $set: { "financialSnapshot.invoiceId": issued._id, "financialSnapshot.invoiceNumber": issued.invoiceNumber } }
      );

      logger.info(`Booking ${booking.bookingNumber} linked to invoice ${issued.invoiceNumber}.`, { tenantId, bookingId });
    } catch (error) {
      logger.error(`BookingFinanceLinkService: failed to create invoice for booking ${bookingId}: ${error.message}`, { tenantId, bookingId });
    }
  }

  /**
   * Records the Stripe-confirmed payment as a real Payment (already
   * Captured — the money already moved via Checkout, so no gateway call is
   * re-attempted here) and allocates it against the receivable this
   * booking's invoice created above, which posts the real Debit-Cash/
   * Credit-AR journal and advances the receivable/invoice status
   * (InvoiceService's own PaymentAllocated listener keeps Invoice.status in
   * sync). A booking with no linked invoice (created before this feature
   * existed, or was $0 at creation) has nothing to allocate against and is
   * skipped — BookingHeaderModel.financialSnapshot itself is already
   * correctly updated by BookingPaymentService regardless.
   */
  static async _handlePaymentSucceeded({ tenantId, bookingId, amountPaid, stripePaymentIntentId, performedBy }) {
    if (!bookingId || !tenantId || !amountPaid) return;
    try {
      const booking = await BookingHeaderModel.findOne({ _id: bookingId, tenantId }).select("financialSnapshot.invoiceNumber").lean();
      const invoiceNumber = booking?.financialSnapshot?.invoiceNumber;
      if (!invoiceNumber) return;

      const receivable = await AccountsReceivableModel.findOne({ tenantId, invoiceNumber }).lean();
      if (!receivable || TERMINAL_RECEIVABLE_STATUSES.has(receivable.status)) return;

      const roundedAmount = roundCurrency(amountPaid);
      const payment = await PaymentService.recordExternalPayment({
        paymentType: "Customer",
        partyType: "customer",
        partyId: receivable.customerId,
        amount: roundedAmount,
        currency: receivable.currency,
        paymentMethod: "Credit Card",
        gateway: "Stripe",
        reference: stripePaymentIntentId || null,
        gatewayTransactionId: stripePaymentIntentId || null
      }, tenantId, performedBy);

      await AccountsReceivableService.allocatePayment(
        receivable._id,
        { paymentId: payment._id, amount: roundedAmount },
        tenantId,
        performedBy
      );

      logger.info(`Booking ${bookingId} payment of ${roundedAmount} allocated to receivable ${receivable._id}.`, { tenantId, bookingId });
    } catch (error) {
      logger.error(`BookingFinanceLinkService: failed to allocate payment for booking ${bookingId}: ${error.message}`, { tenantId, bookingId });
    }
  }
}

export default BookingFinanceLinkService;
