import { Specification } from "../../shared/Specification.js";

/** "A payment sitting in Authorized status is waiting on a separate capture call." Canonical definition — see CanRefundSpecification.js's doc comment for why this moved here. */
export const isPaymentCapturable = (status) => status === "Authorized";

/**
 * Full capture eligibility — status AND the requested capture amount is a
 * valid (possibly partial) slice of what was authorized. Deliberately
 * never throws for an invalid amount (0, negative, oversized) — that's a
 * legitimate "not satisfied" answer, not an exceptional condition; the
 * caller decides what to do with a `false` result.
 */
export class CanCaptureSpecification extends Specification {
  constructor(captureAmount) {
    super();
    this.captureAmount = captureAmount;
  }

  isSatisfiedBy(payment) {
    return isPaymentCapturable(payment.status) && this.captureAmount > 0 && this.captureAmount <= payment.amount;
  }
}
