import { Entity } from "./Entity.js";

// Enterprise DDD Internal Domain Model Standard (Improvement 16) — shared
// building block. An Aggregate Root is the ONLY entity of its aggregate
// that outside code is allowed to hold a reference to or call methods on
// directly — every entity/value object it owns changes only through a
// method on the root, which is what lets the root enforce invariants that
// span the whole aggregate (e.g. "unallocatedAmount can never exceed
// amount") in one place instead of scattered across callers.
//
// `raiseDomainEvent` records a real, meaningful business occurrence at the
// moment an invariant-preserving mutation happens — not a CRUD "field
// changed" event. Deliberately NOT wired into `utils/eventBus.js`'s
// `publishEvent` here: this codebase's existing plain event names
// ("PaymentCaptured", "PaymentRefunded", ...) already have real
// subscribers (WebhookService, BankAccountService, AR/AP) depending on
// their exact current names/payload shape, and Improvement 7 (Event
// Versioning) already established the precedent of never silently
// renaming/restructuring an existing live call site — see
// docs/07-enterprise-standards/16-ddd-domain-model.md "Adoption" for the
// real, deliberate follow-up path (dual-publish once a genuine consumer
// needs the versioned envelope).
export class AggregateRoot extends Entity {
  constructor(id) {
    super(id);
    this._domainEvents = [];
  }

  raiseDomainEvent(name, payload = {}) {
    this._domainEvents.push({ name, payload, occurredAt: new Date() });
  }

  /** Drains and returns the events raised since the last pull — the standard "collect then dispatch" pattern so a caller controls exactly when/if events actually get published. */
  pullDomainEvents() {
    const events = this._domainEvents;
    this._domainEvents = [];
    return events;
  }
}
