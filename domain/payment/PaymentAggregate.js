import { AggregateRoot } from "../shared/AggregateRoot.js";
import { Money } from "./valueObjects/Money.js";
import { CanRefundSpecification, isPaymentRefundable } from "./specifications/CanRefundSpecification.js";
import { CanVoidSpecification, isPaymentVoidable } from "./specifications/CanVoidSpecification.js";
import { CanCaptureSpecification, isPaymentCapturable } from "./specifications/CanCaptureSpecification.js";
import { CanSettleSpecification, isPaymentSettleable } from "./specifications/CanSettleSpecification.js";
import { CanAllocateSpecification, isPaymentAllocatable } from "./specifications/CanAllocateSpecification.js";

const round = (value) => Math.round((Number(value) || 0) * 100) / 100;

/**
 * Payment Module Internal Domain Model (Improvement 16) — Aggregate Root.
 * "Entire invoice/payment ke through hi Items/Payments/Discounts change
 * honge" — this is the ONLY place `unallocatedAmount`/`refundedAmount`/
 * `amount`/`status` are allowed to change together, so the invariant
 * "unallocatedAmount + refundedAmount + (sum of allocations) never exceeds
 * amount" can't be violated by a caller mutating one field and forgetting
 * another.
 *
 * Wraps the live persisted state BY REFERENCE (a Mongoose document, or any
 * plain object with the same shape for unit tests) rather than copying it
 * — `apply*` methods mutate that state in place, so the existing
 * `payment.save()` / `PaymentRepository.save(payment)` call after an
 * `apply*` call persists exactly what the aggregate just decided, with no
 * separate "write the aggregate's fields back onto the document" step to
 * forget.
 */
export class PaymentAggregate extends AggregateRoot {
  constructor(state) {
    if (!state || state._id === undefined || state._id === null) {
      throw new Error("PaymentAggregate requires a persisted Payment state with an _id.");
    }
    super(state._id);
    this.state = state;
  }

  static fromPersistence(paymentState) {
    return new PaymentAggregate(paymentState);
  }

  get status() {
    return this.state.status;
  }

  get money() {
    return new Money(this.state.amount, this.state.currency);
  }

  get unallocatedMoney() {
    return new Money(this.state.unallocatedAmount, this.state.currency);
  }

  isRefundableStatus() {
    return isPaymentRefundable(this.state.status);
  }

  isVoidableStatus() {
    return isPaymentVoidable(this.state.status);
  }

  isCapturableStatus() {
    return isPaymentCapturable(this.state.status);
  }

  isSettleableStatus() {
    return isPaymentSettleable(this.state.status);
  }

  isAllocatableStatus() {
    return isPaymentAllocatable(this.state.status);
  }

  canRefund(amount) {
    return new CanRefundSpecification(amount).isSatisfiedBy(this.state);
  }

  canVoid() {
    return new CanVoidSpecification().isSatisfiedBy(this.state);
  }

  canCapture(captureAmount) {
    return new CanCaptureSpecification(captureAmount).isSatisfiedBy(this.state);
  }

  canSettle() {
    return new CanSettleSpecification().isSatisfiedBy(this.state);
  }

  canAllocate(amount) {
    return new CanAllocateSpecification(amount).isSatisfiedBy(this.state);
  }

  /** Consumes `amount` from the unallocated balance, moving status to Refunded once nothing captured remains unrefunded/unallocated. Caller is responsible for having already verified `canRefund(amount)` (and for the external gateway call, an infrastructure concern this domain layer never performs). */
  applyRefund(amount) {
    const roundedAmount = round(amount);
    this.state.unallocatedAmount = round(this.state.unallocatedAmount - roundedAmount);
    this.state.refundedAmount = round((this.state.refundedAmount || 0) + roundedAmount);
    if (this.state.unallocatedAmount === 0 && this.state.refundedAmount === this.state.amount) {
      this.state.status = "Refunded";
    }
    this.raiseDomainEvent("PaymentRefunded.v1", { paymentId: String(this.id), amount: roundedAmount, currency: this.state.currency });
    return this.state;
  }

  applyVoid(voidedBy = null) {
    this.state.status = "Voided";
    this.state.voidedAt = new Date();
    this.state.voidedBy = voidedBy;
    this.raiseDomainEvent("PaymentVoided.v1", { paymentId: String(this.id) });
    return this.state;
  }

  /** Sets the payment's amount/unallocatedAmount to what was actually captured — a partial capture legitimately shrinks the payment, since nothing has been allocated against it yet at the Authorized stage. */
  applyCapture(captureAmount) {
    const roundedAmount = round(captureAmount);
    const isPartial = roundedAmount < this.state.amount;
    this.state.amount = roundedAmount;
    this.state.unallocatedAmount = roundedAmount;
    this.state.status = "Captured";
    this.raiseDomainEvent("PaymentCaptured.v1", { paymentId: String(this.id), amount: roundedAmount, currency: this.state.currency, partial: isPartial });
    return { isPartial };
  }

  applySettle() {
    this.state.status = "Settled";
    this.raiseDomainEvent("PaymentSettled.v1", { paymentId: String(this.id) });
    return this.state;
  }

  /** Records a new allocation entity and decrements the unallocated balance — the same choke point services/PaymentService.js#consumeUnallocatedAmount has always been, moved into the aggregate that actually owns the invariant. */
  applyAllocation(amount, { targetType, targetId, allocatedBy } = {}) {
    const roundedAmount = round(amount);
    this.state.unallocatedAmount = round(this.state.unallocatedAmount - roundedAmount);
    if (targetType && targetId) {
      this.state.allocations = this.state.allocations || [];
      this.state.allocations.push({ targetType, targetId, amount: roundedAmount, allocatedBy: allocatedBy || null, allocatedAt: new Date() });
    }
    if (this.state.unallocatedAmount === 0 && this.state.status === "Captured") {
      this.state.status = "Allocated";
    }
    this.raiseDomainEvent("PaymentAllocated.v1", { paymentId: String(this.id), amount: roundedAmount, targetType: targetType || null, targetId: targetId ? String(targetId) : null });
    return this.state;
  }
}
