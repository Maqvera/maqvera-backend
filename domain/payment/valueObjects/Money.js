import { ValueObject } from "../../shared/ValueObject.js";

const round = (value) => Math.round((Number(value) || 0) * 100) / 100;

// Payment Module Internal Domain Model (Improvement 16) — Value Object.
// No identity, immutable, arithmetic always returns a new instance. Same
// rounding rule PaymentService has always used (roundCurrency) — moved
// here as the one real definition rather than re-derived.
export class Money extends ValueObject {
  constructor(amount, currency) {
    if (amount === undefined || amount === null || Number.isNaN(Number(amount))) {
      throw new Error("Money requires a numeric amount.");
    }
    if (!currency || typeof currency !== "string") {
      throw new Error("Money requires a currency.");
    }
    super({ amount: round(amount), currency });
  }

  get amount() {
    return this.props.amount;
  }

  get currency() {
    return this.props.currency;
  }

  _assertSameCurrency(other) {
    if (other.currency !== this.currency) {
      throw new Error(`Currency mismatch: ${this.currency} vs ${other.currency}.`);
    }
  }

  add(other) {
    this._assertSameCurrency(other);
    return new Money(this.amount + other.amount, this.currency);
  }

  subtract(other) {
    this._assertSameCurrency(other);
    return new Money(this.amount - other.amount, this.currency);
  }

  isGreaterThan(other) {
    this._assertSameCurrency(other);
    return this.amount > other.amount;
  }

  isGreaterThanOrEqual(other) {
    this._assertSameCurrency(other);
    return this.amount >= other.amount;
  }

  isZero() {
    return this.amount === 0;
  }

  isPositive() {
    return this.amount > 0;
  }

  toString() {
    return `${this.amount.toFixed(2)} ${this.currency}`;
  }
}
