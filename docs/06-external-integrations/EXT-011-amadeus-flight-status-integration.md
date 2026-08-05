---
title: External Integration API — EXT-011 Amadeus Flight Status API
document_id: EXT-011
version: 1.0.0
status: Production Ready
module: External Integrations
provider: Amadeus
---

# EXT-011 — Amadeus Flight Status API

---

## 1. Overview

Read-only, real-time operational status for a scheduled/booked flight (delay, gate, terminal, departure/arrival times). Best-effort syncs a matching internal `TravelFlightAssignmentModel` through the same workflow engine the existing manual staff status-update endpoint uses — but the live status response is always returned regardless of whether that internal sync succeeds.

---

## 2. Audit Finding

Nothing implementing live Amadeus flight status existed. A rich MANUAL status-update path already existed (`TravelFlightController.js`'s `PATCH /api/v1/travel-plans/:travelPlanId/flights/:flightAssignmentId/status`, gate/terminal update endpoint, `delayHistory`/`actualDeparture`/`actualArrival` fields, a full workflow-engine-governed flight lifecycle in `utils/flightConfig.js`) — but it's entirely staff-entered. `utils/SupplierIntegrationLayer.js`'s `AirlineConnector.checkFlightStatus()` was a stub explicitly commented as simulated/mock and deliberately never wired to real logic, for exactly the reason this whole session cares about: not writing fabricated data into real flight records. This document is what makes that connection real.

**A real, previously-invisible bug found and fixed**: `executeWorkflowTransition`'s own `getOrCreateWorkflowInstance()` call never passes an `initialState`, so it always defaults to the hardcoded `"draft"`. `"draft"` does not appear anywhere as a `fromState` in the Flight workflow's transition table (`utils/flightConfig.js` starts at `"scheduled"`) — meaning **every first transition attempt for any flight, including the pre-existing manual staff endpoint, always threw** `"Transition '...' is not allowed from current state 'draft'"`. Booking already avoids this correctly (`BookingController.js` explicitly pre-seeds `initialState: booking.status`); Flight never did. Since this document's own automated status sync depends on the same transition mechanism working, both the manual endpoint (`TravelFlightController.js`) and this document's own sync path now pre-seed the workflow instance with the flight's real current status before attempting a transition.

---

## 3. Endpoint

`GET /api/v1/integrations/amadeus/flights/status`

Requires `Authorization: Bearer <JWT>` and the `travel.flight.read` permission.

### Query Parameters
- `flightNumber` (required) — accepts either a combined form (`SV701`) or a bare number (`701`) with `airlineCode` supplied separately.
- `departureDate` (optional, `YYYY-MM-DD`) — defaults to today.
- `airlineCode`, `originAirport`, `destinationAirport` (optional).

---

## 4. Real Amadeus Endpoint & Status Derivation

Calls Amadeus's real On-Demand Flight Status API — `GET /v2/schedule/flights?carrierCode=&flightNumber=&scheduledDepartureDate=`. Unlike search/pricing/booking, this endpoint's raw response is **timing data** (standard scheduled/estimated/actual departure & arrival qualifiers — STD/ETD/ATD/STA/ETA/ATA), not a ready-made status string — genuine normalization is required, not optional.

**Statuses this implementation confidently derives from live data**: `Scheduled`, `Boarding`, `Gate Open`, `Delayed` (estimated-vs-scheduled gap ≥ `GDS_FLIGHT_STATUS_DELAY_THRESHOLD_MINUTES`, default 15), `Departed`/`In Flight` (via actual-departure timing), `Arrived` (via actual-arrival timing), `Unknown` (no usable timing data at all).

**Deliberately not derived from live data**: `Cancelled`, `Diverted`, `Returned`. This codebase has no confirmed, real field in Amadeus's raw payload to key these off with confidence — guessing one risks reporting a cancellation that never happened, which is a materially worse failure mode than under-reporting. These three values remain reachable via the dynamic-sandbox generator (for realistic testing) and the pre-existing manual staff-reported workflow — an honest gap, documented rather than papered over with a guessed field name.

**`Gate Changed`** is not something the raw provider response labels either — it's computed one layer up, by comparing the live gate against the *previously stored* internal gate for a matched flight assignment (§6).

---

## 5. Live vs Dynamic-Sandbox

No live credentials (or a real call finding no matching flight data) → a deterministic (stable per flight+date, not random per call), clearly-labeled dynamic-sandbox status, including occasional `Cancelled`/`Diverted`/`Returned` outcomes for realistic testing coverage of values live normalization can't produce. A **real call that succeeds but returns no matching flight** is treated as `FLIGHT_NOT_FOUND` (404) — never silently substituted with sandbox data, since that would misrepresent "this flight doesn't exist" as "here's its status."

---

## 6. Business Workflow / Internal Sync (as implemented)

The live/sandbox status DTO is **always** computed and returned first. Separately, best-effort: a matching `TravelFlightAssignmentModel` (same tenant, same flight number, `plannedDeparture` on the queried calendar day) is looked up; if found, gate/terminal are synced directly (not workflow-governed fields, same approach the existing manual gate/terminal endpoint already uses), a real delay entry is appended to `delayHistory` when delayed, and — for the 4 statuses that map onto a real workflow action (`Delayed`→"Report Delay", `Departed`→"Depart", `In Flight`→"Confirm In Flight", `Arrived`→"Arrive") — the SAME `executeWorkflowTransition` the manual endpoint uses is invoked with no elevated roles, so an approval-gated or currently-invalid transition is silently skipped (logged), never forced. **Any failure in this internal sync (DB unavailable, invalid transition, etc.) is caught and logged — it never fails the read-only status response itself**, matching §10 "Read-only integration."

---

## 7. Validation Rules (as implemented)

| Doc rule | Implementation |
|---|---|
| Valid Flight Number | Regex format check (`SV701`/`701`+airlineCode) → `INVALID_REQUEST` 400 |
| Valid Date | `YYYY-MM-DD` format + real date check → `INVALID_REQUEST` 400 |
| OAuth Active | Shared `GdsIntegrationService.circuitBreaker` check → `PROVIDER_UNAVAILABLE` 503 |
| Tenant Authorized | `tenantId` required by controller → 403 if absent |

---

## 8. Domain Events

- `FlightStatusUpdated` (already existed, published by the manual endpoint too — same name, no fix needed)
- `FlightDelayed`, `FlightGateChanged`, `FlightDeparted`, `FlightArrived` *(new)*
- `FlightCancelled` *(new — fires only when the live/sandbox status genuinely IS Cancelled/Diverted/Returned; per §4, this never happens from a live-sourced response today, only sandbox or the pre-existing manual path)*
- `GateChanged` (pre-existing event name, kept published alongside the doc-named `FlightGateChanged` — the same "add, never rename" fix pattern applied throughout this EXT-series)
- `TimelineEventCreated` (via `recordCanonicalDomainEvent`, Travel-Plan-linked assignments only)
- `NotificationRequested` *("Notify Stakeholders" — no real Email/SMS/WhatsApp/Push provider exists in this codebase; same honest pattern as EXT-005/009/010, published only for delay/gate-change/cancellation-class updates, not every routine poll)*

---

## 9. Security & Logging

JWT required, tenant isolation, `travel.flight.read` RBAC, full `AuditLogModel` entry on both success and provider failure (flight number, status, source, correlation ID via `requestId`).

---

## 10. Completion Status

- **Status**: Production Ready
- **Document ID**: `EXT-011`
- **Provider**: Amadeus
- **Next Document**: `EXT-012 — Amadeus Flight Schedule API`
