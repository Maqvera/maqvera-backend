import { resolveGateway } from "./policies/GatewayRoutingPolicy.js";
import { Money } from "./valueObjects/Money.js";
import { ReferenceNumber } from "./valueObjects/ReferenceNumber.js";
import { PaymentMethod } from "./valueObjects/PaymentMethod.js";

/**
 * Payment Module Internal Domain Model (Improvement 16) — Factory.
 * "Create Invoice/Payment, Generate Number, Default Currency, Default Tax,
 * Default Status. Never create invoices/payments manually everywhere."
 * Builds the initial, invariant-satisfying state for a brand-new payment —
 * the same shape services/PaymentService.js#createPayment has always
 * assembled by hand, now available as one real, testable, reusable
 * builder. Number generation itself stays an infrastructure/sequence
 * concern (FinanceSequenceModel, atomic per-tenant counter) — this factory
 * takes an already-generated `paymentNumber` rather than reaching into the
 * database itself, keeping it a pure Domain Layer object with zero I/O.
 */
export class PaymentFactory {
  static create({ paymentNumber, paymentType, partyType = null, partyId = null, bankAccountId = null, amount, currency, paymentMethod, requestedGateway, defaultGateway, status, transactionDate, reference = null, createdBy = null }) {
    if (!paymentType) throw new Error("PaymentFactory requires a paymentType.");
    if (!paymentMethod) throw new Error("PaymentFactory requires a paymentMethod.");

    const referenceNumber = new ReferenceNumber(paymentNumber);
    const money = new Money(amount, currency);
    const gateway = resolveGateway(paymentMethod, requestedGateway, defaultGateway);
    const method = new PaymentMethod(paymentMethod, gateway);

    return {
      paymentNumber: referenceNumber.value,
      paymentType,
      partyType,
      partyId,
      bankAccountId,
      amount: money.amount,
      currency: money.currency,
      paymentMethod: method.method,
      gateway: method.gateway,
      status,
      reference,
      transactionDate: transactionDate ? new Date(transactionDate) : new Date(),
      unallocatedAmount: money.amount,
      refundedAmount: 0,
      allocations: [],
      createdBy
    };
  }
}
