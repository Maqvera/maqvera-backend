import { Specification } from "../../shared/Specification.js";

const VOIDABLE_STATUSES = ["Initiated", "Pending", "Authorized", "Captured"];

/** "Statuses a payment must be in to be voided (i.e. before any funds were put to use)." Canonical definition — see CanRefundSpecification.js's doc comment for why this moved here. */
export const isPaymentVoidable = (status) => VOIDABLE_STATUSES.includes(status);

export class CanVoidSpecification extends Specification {
  isSatisfiedBy(payment) {
    return isPaymentVoidable(payment.status);
  }
}
