// Enterprise DDD Internal Domain Model Standard (Improvement 16) — shared
// building block. A Value Object has no identity — two instances with the
// same props ARE the same value — and is immutable: every "mutation"
// (Money.add, etc.) returns a brand-new instance rather than changing this
// one, enforced here via Object.freeze rather than by convention only.
export class ValueObject {
  constructor(props) {
    if (!props || typeof props !== "object") {
      throw new Error("ValueObject requires a props object.");
    }
    this._props = Object.freeze({ ...props });
    Object.freeze(this);
  }

  get props() {
    return this._props;
  }

  equals(other) {
    if (!(other instanceof ValueObject)) return false;
    if (other.constructor !== this.constructor) return false;
    return JSON.stringify(this._props) === JSON.stringify(other._props);
  }
}
