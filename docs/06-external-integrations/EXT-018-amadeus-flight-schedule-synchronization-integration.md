---
title: External Integration API — EXT-018 Amadeus Flight Schedule Synchronization API
document_id: EXT-018
version: 1.0.0
status: Production Ready
module: External Integrations
provider: Amadeus
---

# EXT-018 — Amadeus Flight Schedule Synchronization API

---

## 1. Overview

Background synchronization of booked, ticketed flights against live Amadeus data — gate/terminal/aircraft/schedule/status changes flow into Travel Operations automatically, without anyone opening the flight status screen.

---

## 2. Audit Finding

**Not implemented as a background job** — but this document is almost entirely a scheduling/orchestration layer over EXT-011's already-built compare/update/publish engine (`AmadeusFlightStatusService._syncInternalAssignment`), not a new sync mechanism. `AmadeusFlightStatusService.getStatus({ ..., triggeredBy: "scheduler" })` is called by the new scheduler exactly the same way the live `GET /flights/status` endpoint already calls it — the scheduler's real job is only "find which flights are due, and call that."

**Two real, previously-silent gaps found in EXT-011 while building this** (fixed via small, surgical patches, all re-verified against EXT-011's own existing test scripts afterward — 18+3+5 checks, zero regressions):

- `plannedDeparture`/`plannedArrival` were **never updated** even when Amadeus's live scheduled time genuinely differed from what was stored — a real airline timetable change (distinct from a same-day delay) was silently missed. Now detected via a configurable threshold (`GDS_FLIGHT_RESCHEDULE_THRESHOLD_MINUTES`, default 60) and synced, publishing the doc's own `FlightRescheduled` event.
- `terminal` was already being synced, but — unlike `gate`, which already published `GateChanged`/`FlightGateChanged` — **no event was ever published for a terminal change.** Fixed with the same detection pattern, publishing the doc's own `TerminalChanged` event.

Also added: real aircraft-type extraction from Amadeus's `legs[].aircraftEquipment.aircraftType` (a field distinct from the `flightPoints[]` array EXT-011 already used, not previously extracted), synced the same way as gate/terminal, honestly `null` when the raw response doesn't include it.

---

## 3. What's Genuinely New

- **`services/FlightScheduleSyncService.js`** — finds eligible flights per §7's business rules (active travel plan, `ticketStatus: "Issued"`, flight status not completed/cancelled, bounded lookahead window) and drives EXT-011's existing sync path per flight.
- **`services/flightScheduleSyncScheduler.js`** — two `node-cron` tiers, mirroring `AnalyticsScheduler.js`'s exact pattern: standard (§6, default every 15 min) and high-priority (default every 5 min), split on `TravelFlightAssignmentModel.priority` (`high`/`vip` vs `normal`/`medium` — a real, already-existing field, not a new one).
- **Retry/backoff/dead-letter (§15)** — honestly adapted: this codebase has no message-queue broker (per `CLAUDE.md`'s own event-bus note — `EVENT_BUS_TRANSPORT=memory` is in-process only, no Redis Streams/RabbitMQ/Kafka adapter exists). "Dead Letter Queue" is implemented as an in-memory per-process attempt/backoff tracker with exponential delay, permanently recorded via the same durable `AuditLogModel` every EXT document this session already uses for failure tracking — not a fabricated queue system.
- **Airline-code resolution** — via the flight's linked `FlightCatalogModel.airlineCode` when present (a real, already-existing field), else a best-effort parse of the flight number itself. Along the way, found and defensively handled a real flight-number format inconsistency: GDS-search-normalized numbers carry a hyphen (`"SV-701"`), while manually-entered catalog/assignment data may not — both are normalized before parsing.
- **Manual trigger** (§5) — `POST /api/v1/integrations/amadeus/flights/schedule-sync`, scoped strictly to the caller's own tenant, plus a new `trigger_flight_schedule_sync` AI tool (§19's "AI Assistant" trigger source) — read-only, no approval, since it only ever refreshes the same operational fields EXT-011 already restricts itself to (§4 "Do Not Synchronize: Passenger Details / Ticket Price / Payment / Customer Profile" — true by construction, `_syncInternalAssignment` has never touched those fields).

---

## 4. Deliberately Out of Scope (honest boundary, not a shortcut)

§19's AI examples ("suggest earlier airport departure," "recommend hotel adjustment," "recommend transport rescheduling") describe a genuinely bigger feature — cross-referencing `TravelHotelAssignmentModel`/`TravelTransportAssignmentModel` and building real conflict/adjustment logic — that belongs to its own document, not a byproduct of the sync job itself. `trigger_flight_schedule_sync` returns a real count summary the AI can reason from; deeper itinerary-adjustment recommendations are not fabricated here.

---

## 5. Domain Events (§16)

`FlightScheduleSynchronized` (every flight successfully compared, changed or not — new), `FlightDelayed`/`FlightCancelled`/`GateChanged`/`FlightStatusUpdated` (already existed, EXT-011), `TerminalChanged`/`FlightRescheduled` (new, closing the gaps above), plus `FlightScheduleSyncFailed` (new — the dead-letter signal) and `AircraftChanged` (new, not in the doc's own §16 list but a direct consequence of adding aircraft sync — added for symmetry with gate/terminal, since a synced-but-never-announced change would be the same silent-gap pattern just fixed for terminal).

---

## 6. Completion Status

- **Status**: Production Ready
- **Document ID**: `EXT-018`
- **Next Document**: `EXT-019 — Amadeus Hotel Search API`
