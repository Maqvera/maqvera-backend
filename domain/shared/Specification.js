// Enterprise DDD Internal Domain Model Standard (Improvement 16) — shared
// building block. "Instead of if/if/if/if/if/if, everything stays clean" —
// a Specification packages one business predicate into a named, testable,
// composable object instead of an inline boolean expression repeated
// (and inevitably drifting) at every call site.
export class Specification {
  isSatisfiedBy(_candidate) {
    throw new Error("isSatisfiedBy() must be implemented by a concrete Specification.");
  }

  and(other) {
    return new AndSpecification(this, other);
  }

  or(other) {
    return new OrSpecification(this, other);
  }

  not() {
    return new NotSpecification(this);
  }
}

class AndSpecification extends Specification {
  constructor(left, right) {
    super();
    this.left = left;
    this.right = right;
  }
  isSatisfiedBy(candidate) {
    return this.left.isSatisfiedBy(candidate) && this.right.isSatisfiedBy(candidate);
  }
}

class OrSpecification extends Specification {
  constructor(left, right) {
    super();
    this.left = left;
    this.right = right;
  }
  isSatisfiedBy(candidate) {
    return this.left.isSatisfiedBy(candidate) || this.right.isSatisfiedBy(candidate);
  }
}

class NotSpecification extends Specification {
  constructor(inner) {
    super();
    this.inner = inner;
  }
  isSatisfiedBy(candidate) {
    return !this.inner.isSatisfiedBy(candidate);
  }
}
