import { Specification } from "../../shared/Specification.js";

/** "Statuses a payment must be in to accept a new allocation." Canonical definition — see CanRefundSpecification.js's doc comment for why this moved here. */
export const isPaymentAllocatable = (status) => ["Captured", "Allocated"].includes(status);

/** Full allocation eligibility — status AND the requested amount fits within what's still unallocated. Deliberately never throws for a non-positive amount — that's a legitimate "not satisfied" answer, not an exceptional condition. */
export class CanAllocateSpecification extends Specification {
  constructor(amount) {
    super();
    this.amount = amount;
  }

  isSatisfiedBy(payment) {
    return isPaymentAllocatable(payment.status) && this.amount > 0 && this.amount <= payment.unallocatedAmount;
  }
}
