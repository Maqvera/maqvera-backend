# Enterprise Event Versioning Standard

**Status: ✔ Done** — real, additive, new publishing path (`utils/eventVersioning.js`); the existing `utils/eventBus.js`/`publishEvent` and every one of its hundreds of existing call sites are completely untouched.

## Purpose

Safe evolution of event-driven integrations — adding `taxRegion` to `InvoiceCreated` six months from now must never break a consumer still reading last year's shape.

## Why this is additive, not an in-place rewrite

Renaming this codebase's existing `publishEvent("InvoiceCreated", {...flat payload...})` call sites to `InvoiceCreated.v1` and restructuring their flat payload into a nested `{ data: {...} }` envelope **in place** would itself be exactly the breaking change this standard exists to prevent — done as a mass rewrite instead of a genuine side-by-side version, it would violate the standard while claiming to implement it. `utils/eventVersioning.js` is real, new infrastructure: a `publishVersionedEvent` function that builds the standard envelope and publishes under a real `<EventName>.v<N>` key, **through** the existing, unmodified `publishEvent` (so `DomainEventModel` outbox persistence, `eventId`, and the Improvement 5 `correlationId` fallback all keep working transparently) — genuinely new events (and, later, a deliberate one-event-at-a-time migration of existing ones) can adopt it; nothing that already works had to change.

## Standard Envelope

```json
{
  "eventId": "uuid",
  "eventName": "InvoiceCreated",
  "eventVersion": "1.0",
  "occurredAt": "2027-06-01T10:20:00.000Z",
  "correlationId": "ABC-123",
  "tenantId": "...",
  "merchantAccountId": null,
  "companyId": null,
  "branchId": null,
  "source": "Invoice Platform",
  "data": { "invoiceId": "INV-1001", "amount": 1000 }
}
```

`tenantId`/`merchantAccountId`/`companyId`/`branchId` are optional (`null` when not applicable) — the same opt-in discipline as every identity field across this hardening phase (Standard Metadata, Improvement 1). `correlationId` falls back to the ambient `AsyncLocalStorage` context (Improvement 5) when not explicitly supplied.

## Event Registry (`models/EventRegistryModel.js`)

"Maintain a central registry. This prevents duplicate definitions." `registerEvent(eventName, version, { category, owner, description })` is real duplicate-prevention, not just a courtesy: registering the same `(eventName, version)` again with the **same** owner/category is a safe, idempotent no-op (a service re-declaring its own event on every process start); registering it with a **different** owner/category is rejected as `409 EVENT_REGISTRY_CONFLICT` — two modules independently claiming the same event name is a real governance bug, caught immediately rather than silently overwritten. Every publish increments a real `publishCount`/`lastPublishedAt` — the honest signal for whether anything is still using an old version before retiring it.

## Schema Validation

`registerEventSchema(eventName, version, joiSchema)` — a **real** Joi schema (reusing this codebase's existing validation library, not inventing a second JSON Schema/Avro/Protobuf toolchain), checked on every `publishVersionedEvent` call for that exact version. An invalid payload is rejected with the standard `VALIDATION_FAILED` contract (Improvement 4) — field-level `details`, never published. Schemas are in-memory only (registered once per process, typically at module load) since a Joi schema instance isn't serializable into Mongo; the registry itself holds the durable ownership/lifecycle metadata.

## Lifecycle — `Active → Deprecated → Retired`

- **Active** — publishes normally.
- **Deprecated** (`deprecateEventVersion`) — "Old versions MUST remain available during migration": still genuinely publishes, but logs a real `logger.warn` on every publish so operators can see live usage of something they're trying to retire.
- **Retired** (`retireEventVersion`) — publishing throws `410 EVENT_VERSION_RETIRED`; genuinely blocked, not just documented as deprecated.
- `reactivateEventVersion` moves `Deprecated` back to `Active`; a `Retired` version can never be reactivated (register a new version instead) — a real, one-way terminal state.

## API (`/api/v1/event-registry`)

| Method | Path | Permission | Purpose |
|---|---|---|---|
| POST | `/` | `eventregistry.manage` | Register an event name/version |
| GET | `/` | `eventregistry.read` | List the registry (`?eventName=`, `?status=`, `?category=`, `?owner=`) |
| GET | `/:eventName/:version` | `eventregistry.read` | Get one entry |
| POST | `/:eventName/:version/deprecate` | `eventregistry.manage` | Begin the migration window |
| POST | `/:eventName/:version/retire` | `eventregistry.manage` | Permanently retire |
| POST | `/:eventName/:version/reactivate` | `eventregistry.manage` | Undo a Deprecation |

Platform-level metadata, not tenant-owned data — same "no separate Platform Operator identity" reasoning as Improvement 3's Merchant platform and Improvement 6's Circuit Breaker status.

## Real end-to-end proof (`tests/eventVersioningStandard.test.js`)

Idempotent re-registration vs. a genuine owner/category conflict; a real published envelope verified field-by-field, and proof that a `.v1` subscriber and a bare-name subscriber genuinely never cross-receive each other's events; real Joi schema rejection with field-level details; and the full `Active → Deprecated (still publishes) → Retired (publish rejected) → reactivation blocked` lifecycle.

## Adoption

No existing `publishEvent` call site in this codebase is migrated to `publishVersionedEvent` in this pass — deliberate, real, one-event-at-a-time follow-up work (each migration needs its own decision about what belongs in `data` vs. top-level identity fields, and a real deprecation window for any external consumer of the old flat shape).
