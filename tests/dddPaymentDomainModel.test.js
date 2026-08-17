import test from "node:test";
import assert from "node:assert/strict";
import { Entity } from "../domain/shared/Entity.js";
import { ValueObject } from "../domain/shared/ValueObject.js";
import { AggregateRoot } from "../domain/shared/AggregateRoot.js";
import { Specification } from "../domain/shared/Specification.js";
import { Money } from "../domain/payment/valueObjects/Money.js";
import { PaymentMethod } from "../domain/payment/valueObjects/PaymentMethod.js";
import { ReferenceNumber } from "../domain/payment/valueObjects/ReferenceNumber.js";
import { PaymentAllocation } from "../domain/payment/entities/PaymentAllocation.js";
import { PaymentAggregate } from "../domain/payment/PaymentAggregate.js";
import { PaymentRepository } from "../domain/payment/PaymentRepository.js";
import { PaymentFactory } from "../domain/payment/PaymentFactory.js";
import { resolveGateway } from "../domain/payment/policies/GatewayRoutingPolicy.js";
import { RefundPolicy } from "../domain/payment/policies/RefundPolicy.js";
import { CanRefundSpecification, isPaymentRefundable } from "../domain/payment/specifications/CanRefundSpecification.js";
import { CanVoidSpecification, isPaymentVoidable } from "../domain/payment/specifications/CanVoidSpecification.js";
import { CanCaptureSpecification, isPaymentCapturable } from "../domain/payment/specifications/CanCaptureSpecification.js";
import { CanSettleSpecification, isPaymentSettleable } from "../domain/payment/specifications/CanSettleSpecification.js";
import { CanAllocateSpecification, isPaymentAllocatable } from "../domain/payment/specifications/CanAllocateSpecification.js";
import { computeFraudRiskScore, deriveFraudStatus } from "../domain/payment/services/PaymentFraudDomainService.js";
import PaymentService, {
  resolveGateway as reExportedResolveGateway,
  computeFraudRiskScore as reExportedComputeFraudRiskScore,
  isPaymentRefundable as reExportedIsPaymentRefundable
} from "../services/PaymentService.js";

// Enterprise Domain-Driven Design Internal Domain Model Standard
// (Improvement 16). Pure/static building blocks — no MongoDB dependency,
// same convention as tests/errorContractStandard.test.js and
// tests/paginationStandard.test.js. Flagship module: Payment (the same
// flagship Improvement 15 documented at POST /payments) — the richest
// real domain in this codebase and the spec's own worked example.

test("Entity: identity equality, not structural equality", () => {
  class Widget extends Entity {}
  const a = new Widget("id-1");
  const b = new Widget("id-1");
  const c = new Widget("id-2");
  assert.equal(a.equals(b), true, "same id => equal, even though they are different instances");
  assert.equal(a.equals(c), false);
  assert.throws(() => new Widget(null), /non-empty identity/);
});

test("ValueObject: structural equality and real immutability (frozen, not just conventionally treated as immutable)", () => {
  class Pair extends ValueObject {}
  const a = new Pair({ x: 1, y: 2 });
  const b = new Pair({ x: 1, y: 2 });
  const c = new Pair({ x: 1, y: 3 });
  assert.equal(a.equals(b), true);
  assert.equal(a.equals(c), false);
  assert.throws(() => { a.props.x = 99; }, TypeError, "mutating a frozen ValueObject's props must throw in strict mode");
});

test("AggregateRoot: raises and drains domain events (collect-then-dispatch pattern)", () => {
  class Widget extends AggregateRoot {}
  const widget = new Widget("id-1");
  assert.deepEqual(widget.pullDomainEvents(), []);
  widget.raiseDomainEvent("WidgetCreated.v1", { foo: "bar" });
  widget.raiseDomainEvent("WidgetUpdated.v1", { foo: "baz" });
  const events = widget.pullDomainEvents();
  assert.equal(events.length, 2);
  assert.equal(events[0].name, "WidgetCreated.v1");
  assert.deepEqual(events[0].payload, { foo: "bar" });
  assert.ok(events[0].occurredAt instanceof Date);
  assert.deepEqual(widget.pullDomainEvents(), [], "a second pull drains nothing new");
});

test("Specification: and/or/not composition", () => {
  class IsEven extends Specification { isSatisfiedBy(n) { return n % 2 === 0; } }
  class IsPositive extends Specification { isSatisfiedBy(n) { return n > 0; } }
  const evenAndPositive = new IsEven().and(new IsPositive());
  assert.equal(evenAndPositive.isSatisfiedBy(4), true);
  assert.equal(evenAndPositive.isSatisfiedBy(-4), false);
  assert.equal(evenAndPositive.isSatisfiedBy(3), false);
  assert.equal(new IsEven().or(new IsPositive()).isSatisfiedBy(-3), false);
  assert.equal(new IsEven().or(new IsPositive()).isSatisfiedBy(3), true);
  assert.equal(new IsEven().not().isSatisfiedBy(3), true);
});

test("Money: immutable arithmetic, currency-mismatch guard, rounding matches the codebase's existing roundCurrency convention", () => {
  const a = new Money(10.005, "USD");
  assert.equal(a.amount, 10.01, "rounds to 2dp the same way services/PaymentService.js#roundCurrency always has");
  const b = new Money(5, "USD");
  const sum = a.add(b);
  assert.equal(sum.amount, 15.01);
  assert.equal(a.amount, 10.01, "original instance is untouched — add() returns a new Money");
  assert.throws(() => a.add(new Money(1, "EUR")), /Currency mismatch/);
  assert.equal(new Money(0, "USD").isZero(), true);
  assert.equal(a.isPositive(), true);
});

test("PaymentMethod and ReferenceNumber value objects validate their invariants", () => {
  const pm = new PaymentMethod("Cash", "Manual");
  assert.equal(pm.isManual, true);
  assert.throws(() => new PaymentMethod("", "Manual"));
  assert.throws(() => new ReferenceNumber(""));
  assert.equal(new ReferenceNumber("PAY-2026-000123").toString(), "PAY-2026-000123");
});

test("PaymentAllocation entity requires a positive amount and real target identity", () => {
  assert.throws(() => new PaymentAllocation({ targetType: "Booking", targetId: "b1", amount: 0 }));
  assert.throws(() => new PaymentAllocation({ targetType: null, targetId: "b1", amount: 10 }));
  const allocation = new PaymentAllocation({ targetType: "Booking", targetId: "b1", amount: 50 });
  assert.equal(allocation.amount, 50);
});

test("GatewayRoutingPolicy.resolveGateway / RefundPolicy mirror the exact business rules services/PaymentService.js has always enforced", () => {
  assert.equal(resolveGateway("Cash", undefined, "Stripe"), "Manual");
  assert.equal(resolveGateway("Credit Card", undefined, "Stripe"), "Stripe");
  assert.equal(resolveGateway("Cash", "Stripe", "Manual"), "Stripe", "an explicit request always wins");

  const captured = { status: "Captured", unallocatedAmount: 100 };
  assert.equal(RefundPolicy.maxRefundableAmount(captured), 100);
  assert.equal(RefundPolicy.maxRefundableAmount({ status: "Initiated", unallocatedAmount: 100 }), 0);
  assert.deepEqual(RefundPolicy.evaluate(captured, 50), { allowed: true, reason: null });
  assert.equal(RefundPolicy.evaluate({ status: "Initiated", unallocatedAmount: 0 }, 50).allowed, false);
  assert.match(RefundPolicy.evaluate(captured, 500).reason, /exceeds the unallocated portion/);
});

test("Specifications: canonical predicates match the exact statuses PaymentService.js has always used (regression-locking the Improvement 16 move)", () => {
  assert.equal(isPaymentRefundable("Captured"), true);
  assert.equal(isPaymentRefundable("Initiated"), false);
  assert.equal(isPaymentVoidable("Authorized"), true);
  assert.equal(isPaymentVoidable("Allocated"), false);
  assert.equal(isPaymentCapturable("Authorized"), true);
  assert.equal(isPaymentCapturable("Captured"), false);
  assert.equal(isPaymentSettleable("Captured"), true);
  assert.equal(isPaymentSettleable("Voided"), false);
  assert.equal(isPaymentAllocatable("Allocated"), true);
  assert.equal(isPaymentAllocatable("Voided"), false);

  assert.equal(new CanRefundSpecification(50).isSatisfiedBy({ status: "Captured", unallocatedAmount: 100 }), true);
  assert.equal(new CanRefundSpecification(150).isSatisfiedBy({ status: "Captured", unallocatedAmount: 100 }), false);
  assert.equal(new CanRefundSpecification(0).isSatisfiedBy({ status: "Captured", unallocatedAmount: 100 }), false, "a non-positive amount is a legitimate false, never a thrown exception");
  assert.equal(new CanVoidSpecification().isSatisfiedBy({ status: "Captured" }), true);
  assert.equal(new CanCaptureSpecification(50).isSatisfiedBy({ status: "Authorized", amount: 100 }), true);
  assert.equal(new CanCaptureSpecification(150).isSatisfiedBy({ status: "Authorized", amount: 100 }), false);
  assert.equal(new CanSettleSpecification().isSatisfiedBy({ status: "Allocated" }), true);
  assert.equal(new CanAllocateSpecification(50).isSatisfiedBy({ status: "Captured", unallocatedAmount: 100 }), true);
});

test("PaymentFraudDomainService: identical output to the pure fraud logic PaymentService.js has always run", () => {
  assert.deepEqual(computeFraudRiskScore({ isDuplicate: true, velocityCount: 1, velocityMax: 5, amount: 100, amountThreshold: 1000 }), { riskScore: 40, flags: ["DuplicatePayment"] });
  assert.equal(deriveFraudStatus(75, { reviewThreshold: 40, flagThreshold: 70 }), "Flagged");
});

test("PaymentAggregate: enforces the SAME refund/void/capture/settle invariants PaymentService.js has always enforced inline, mutating the wrapped state by reference", () => {
  const state = { _id: "pay1", status: "Captured", amount: 100, currency: "USD", unallocatedAmount: 100, refundedAmount: 0 };
  const aggregate = PaymentAggregate.fromPersistence(state);

  assert.equal(aggregate.canRefund(40), true);
  aggregate.applyRefund(40);
  assert.equal(state.unallocatedAmount, 60, "the aggregate mutates the SAME object passed in — no separate write-back step to forget");
  assert.equal(state.refundedAmount, 40);
  assert.equal(state.status, "Captured", "not yet fully refunded");

  assert.equal(aggregate.canRefund(60), true);
  aggregate.applyRefund(60);
  assert.equal(state.status, "Refunded", "unallocatedAmount hit 0 and refundedAmount == amount => Refunded");

  const events = aggregate.pullDomainEvents();
  assert.equal(events.length, 2);
  assert.equal(events[0].name, "PaymentRefunded.v1");
  assert.equal(events[1].payload.amount, 60);
});

test("PaymentAggregate: void and capture transitions", () => {
  const voidable = { _id: "pay2", status: "Captured", amount: 100, currency: "USD", unallocatedAmount: 100, refundedAmount: 0 };
  const voidAggregate = PaymentAggregate.fromPersistence(voidable);
  assert.equal(voidAggregate.canVoid(), true);
  voidAggregate.applyVoid("user-1");
  assert.equal(voidable.status, "Voided");
  assert.equal(voidable.voidedBy, "user-1");

  const authorized = { _id: "pay3", status: "Authorized", amount: 100, currency: "USD", unallocatedAmount: 0, refundedAmount: 0 };
  const captureAggregate = PaymentAggregate.fromPersistence(authorized);
  assert.equal(captureAggregate.canCapture(40), true);
  const { isPartial } = captureAggregate.applyCapture(40);
  assert.equal(isPartial, true, "40 < the originally-authorized 100 => partial capture");
  assert.equal(authorized.amount, 40, "partial capture legitimately shrinks amount, mirroring PaymentService.js#capturePayment's own documented behavior");
  assert.equal(authorized.unallocatedAmount, 40);
  assert.equal(authorized.status, "Captured");
});

test("PaymentFactory: builds an invariant-satisfying initial Payment state", () => {
  const built = PaymentFactory.create({
    paymentNumber: "PAY-2026-000001",
    paymentType: "Customer",
    amount: 199.999,
    currency: "USD",
    paymentMethod: "Cash",
    defaultGateway: "Stripe",
    status: "Initiated"
  });
  assert.equal(built.paymentNumber, "PAY-2026-000001");
  assert.equal(built.amount, 200, "rounded via the same Money value object");
  assert.equal(built.unallocatedAmount, built.amount);
  assert.equal(built.gateway, "Manual", "Cash always routes Manual regardless of the tenant default, via GatewayRoutingPolicy");
  assert.deepEqual(built.allocations, []);
  assert.throws(() => PaymentFactory.create({ paymentNumber: "X", paymentType: "Customer", amount: 10, currency: "USD", paymentMethod: "", status: "Initiated" }));
});

test("PaymentRepository: real, thin persistence wrapper — save() delegates to the document's own save()", async () => {
  let saved = false;
  const fakeDoc = { save: async () => { saved = true; return fakeDoc; } };
  await PaymentRepository.save(fakeDoc);
  assert.equal(saved, true);
});

test("services/PaymentService.js re-exports the domain layer's canonical predicates unchanged (Improvement 16: moved the definition, kept every existing import site working)", () => {
  assert.equal(reExportedResolveGateway, resolveGateway, "same function reference, not a re-implementation that could drift");
  assert.equal(reExportedComputeFraudRiskScore, computeFraudRiskScore);
  assert.equal(reExportedIsPaymentRefundable, isPaymentRefundable);
  assert.ok(PaymentService.getPaymentById, "PaymentService itself is untouched as the default export/orchestration entry point");
});
