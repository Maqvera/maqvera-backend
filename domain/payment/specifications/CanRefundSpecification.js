import { Specification } from "../../shared/Specification.js";

const REFUNDABLE_STATUSES = ["Captured", "Allocated", "Settled", "Completed"];

/**
 * "Statuses a payment must be in to accept a (partial, unallocated-portion-
 * only) refund." The canonical definition — moved here from
 * services/PaymentService.js (Improvement 16: business rules belong in the
 * Domain Layer, not the Application Service). PaymentService re-exports
 * this exact function so every existing import site
 * (services/RefundService.js, tests/paymentService.test.js) keeps working
 * unchanged.
 */
export const isPaymentRefundable = (status) => REFUNDABLE_STATUSES.includes(status);

/**
 * Full refund eligibility — status AND the requested amount fits within
 * what's still unallocated. Refunding an already-allocated portion is out
 * of scope here by design; the caller must reverse it via that target's
 * own mechanism. Deliberately never throws for a non-positive amount —
 * that's a legitimate "not satisfied" answer, not an exceptional condition.
 */
export class CanRefundSpecification extends Specification {
  constructor(amount) {
    super();
    this.amount = amount;
  }

  isSatisfiedBy(payment) {
    return isPaymentRefundable(payment.status) && this.amount > 0 && this.amount <= payment.unallocatedAmount;
  }
}
