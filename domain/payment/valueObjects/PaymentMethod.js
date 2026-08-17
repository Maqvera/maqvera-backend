import { ValueObject } from "../../shared/ValueObject.js";

// Payment Module Internal Domain Model (Improvement 16) — Value Object.
// Pairs a payment method (Cash/Credit Card/UPI/...) with the gateway it
// actually resolved to (Manual/Stripe/...) — the two travel together for
// the lifetime of one payment and are never meaningfully compared alone.
export class PaymentMethod extends ValueObject {
  constructor(method, gateway) {
    if (!method || typeof method !== "string") {
      throw new Error("PaymentMethod requires a method.");
    }
    if (!gateway || typeof gateway !== "string") {
      throw new Error("PaymentMethod requires a resolved gateway.");
    }
    super({ method, gateway });
  }

  get method() {
    return this.props.method;
  }

  get gateway() {
    return this.props.gateway;
  }

  get isManual() {
    return this.gateway === "Manual";
  }
}
