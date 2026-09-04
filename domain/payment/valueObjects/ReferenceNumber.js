import { ValueObject } from "../../shared/ValueObject.js";

// Payment Module Internal Domain Model (Improvement 16) — Value Object.
// Wraps the server-generated, immutable `paymentNumber`
// (models/PaymentModel.js) — never caller-supplied, so this VO's own job
// is just to make "a real payment number" a checkable type instead of a
// bare string passed around everywhere.
export class ReferenceNumber extends ValueObject {
  constructor(value) {
    if (!value || typeof value !== "string") {
      throw new Error("ReferenceNumber requires a non-empty string.");
    }
    super({ value });
  }

  get value() {
    return this.props.value;
  }

  toString() {
    return this.props.value;
  }
}
