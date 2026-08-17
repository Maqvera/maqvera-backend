import { Specification } from "../../shared/Specification.js";

/** "A payment is when money is authorized or captured. A settlement is when the money is actually transferred and finalized." Canonical definition — see CanRefundSpecification.js's doc comment for why this moved here. */
export const isPaymentSettleable = (status) => ["Captured", "Allocated"].includes(status);

export class CanSettleSpecification extends Specification {
  isSatisfiedBy(payment) {
    return isPaymentSettleable(payment.status);
  }
}
