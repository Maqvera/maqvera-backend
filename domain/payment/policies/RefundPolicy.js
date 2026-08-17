import { CanRefundSpecification, isPaymentRefundable } from "../specifications/CanRefundSpecification.js";

// Payment Module Internal Domain Model (Improvement 16) — Domain Policy.
// Wraps CanRefundSpecification with the human-readable business rule this
// codebase has always enforced (services/PaymentService.js#refund): a
// refund can only ever consume the currently-*unallocated* portion of a
// payment — money already allocated to a target (AR/AP/Booking/...) must
// be reversed through that target's own mechanism instead, because
// reversing it here would silently leave that target's own ledger wrong.
export class RefundPolicy {
  /** The largest amount that can be refunded right now, or 0 if the payment isn't in a refundable status at all. */
  static maxRefundableAmount(payment) {
    return payment && isPaymentRefundable(payment.status) ? payment.unallocatedAmount : 0;
  }

  /** Full policy check for a specific requested amount — status eligibility AND balance sufficiency, in one call. */
  static evaluate(payment, amount) {
    const satisfied = new CanRefundSpecification(amount).isSatisfiedBy(payment);
    if (satisfied) return { allowed: true, reason: null };
    if (!isPaymentRefundable(payment.status)) {
      return { allowed: false, reason: `Payment cannot be refunded from status "${payment.status}".` };
    }
    return { allowed: false, reason: `Refund amount exceeds the unallocated portion available (${payment.unallocatedAmount}). Already-allocated funds must be reversed via their own target's mechanism.` };
  }
}
