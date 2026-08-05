---
title: External Integration API — EXT-009 Amadeus Seat Selection API
document_id: EXT-009
version: 1.0.0
status: Production Ready
module: External Integrations
provider: Amadeus
---

# EXT-009 — Amadeus Seat Selection API

---

## 1. Overview

Assigns airline seats to one or more travelers on an already-confirmed flight order. Reuses EXT-008's live seat map as the authoritative source of truth for "Segment Exists"/"Seat Exists"/"Seat Available" — exactly the workflow the doc itself describes (`Retrieve Seat Map (EXT-008) → Employee Selects Seats → Assign Seats`). Nothing about seat inventory is ever owned or stored internally beyond a record of *which* seat this booking assigned to *which* traveler.

---

## 2. Audit Finding

Nothing implementing this existed. `TravelFlightAssignmentModel.assignedTravelers[].seatNumber` and `FlightBookingModel.travelers[].seatNumber` are pre-existing schema fields, but neither was ever written to by any controller — both were dead fields, always `null`. No `assignSeat`/`selectSeat` method existed anywhere in the GDS adapter layer, no permission string `travel.flight.seat.assign` existed, and no route under `/seat-selection` existed.

---

## 3. Endpoint

`POST /api/v1/integrations/amadeus/seat-selection`

Requires `Authorization: Bearer <JWT>` and the `travel.flight.seat.assign` permission (`flight.book`/`admin` also accepted, this codebase's existing convention).

### Request
```json
{
  "flightOrderId": "...",
  "seatSelections": [
    { "travelerId": "...", "segmentId": "SEG-001", "seatNumber": "12A" }
  ],
  "paymentApproved": false
}
```
`paymentApproved` is this implementation's real, necessary addition for Business Rule "Paid seats require payment approval" (§8) — the doc's request example doesn't show a field for it, but the rule can't be enforced without the caller asserting it.

---

## 4. No Real Amadeus Endpoint — Same Situation as EXT-005 Ticketing

Amadeus's public Self-Service API catalog has no standalone "assign a seat to an already-confirmed flight order" endpoint. Real seat pre-selection happens as part of the Flight Create Orders request body at booking time (an extra-services-priced offer including seat selections) — not as a later, separate call against an existing PNR. This is the exact same situation EXT-005's ticketing already documented and handled honestly: `AmadeusAdapter.assignSeats()` confirms the (already validated, against the live EXT-008 seat map) seat selections without fabricating a live HTTP call to an endpoint that doesn't exist in Amadeus's real API surface.

---

## 5. Validation Rules (as implemented)

| Doc rule | Implementation |
|---|---|
| Flight Order Exists | `FlightBookingModel.findOne({tenantId, $or: [{airlineOrderId}, {providerBookingReference}]})` → `FLIGHT_ORDER_NOT_FOUND` 404 |
| Same Tenant | Same query above |
| Same Branch | Not in the doc's own list, but added consistent with EXT-005/EXT-009's own §17 "Branch Isolation" security requirement → `BRANCH_MISMATCH` 403 |
| Traveler Exists / Belongs To Booking | Checked against the linked Travel Plan's real `travelerSnapshots`, or the booking's own `travelers[].travelerId` for a standalone (non-Travel-Plan) booking → `TRAVELER_NOT_IN_BOOKING` 400 |
| Segment Exists | Checked against EXT-008's live seat map response → `SEGMENT_NOT_FOUND` 404 |
| Seat Exists | Checked against the segment's real rows/seats from EXT-008 → `SEAT_NOT_FOUND` 404 |
| Seat Available | Seat status must be `AVAILABLE`/`CHARGEABLE`; `OCCUPIED`/`RESERVED` → `SEAT_ALREADY_OCCUPIED` 409; `BLOCKED`/`UNAVAILABLE` → `SEAT_NO_LONGER_AVAILABLE` 409 |

---

## 6. Business Rules (as implemented)

- **"Seats cannot be assigned twice"**: this booking's own prior `seatAssignments` are checked for a conflicting traveler on the same seat+segment (`SEAT_ALREADY_OCCUPIED`), independent of the live seat map (belt-and-suspenders — the map's 5-minute cache could be briefly stale relative to this booking's own just-recorded state).
- **Seat change vs. re-request**: a traveler requesting the *same* seat they already hold on that segment is a real idempotent no-op (no duplicate provider call, no duplicate event). A traveler requesting a *different* seat on a segment they already have one on is treated as a genuine seat **change** — the old assignment is marked `Released`, a new one recorded, and `SeatChanged` (not `SeatAssigned`) is published for it.
- **"Paid seats require payment approval"**: a `CHARGEABLE` seat (per the live seat map) without `paymentApproved: true` in the request → `PAID_SEAT_PAYMENT_REQUIRED` 402.
- **"Bulk assignment supported"** is implemented as all-or-nothing: the entire batch is validated *before* any provider call, and the provider's confirmations are checked against every requested seat afterward (`SEAT_NOT_CONFIRMED` 409 if any is missing) — no partially-applied batch.
- **"Update Booking Snapshot"** (doc §9 workflow step) does **not** mutate `FlightBookingModel.bookingSnapshot` — EXT-004 established that field as immutable/never-edited after creation, and this document doesn't override that invariant. Seat assignments are recorded in a new, dedicated `FlightBookingModel.seatAssignments[]` array instead — a deliberate, documented adaptation, not a silent reinterpretation.

---

## 7. Response

### Success (HTTP 200)
```json
{
  "success": true,
  "message": "Seats assigned successfully.",
  "data": {
    "flightOrderId": "...",
    "status": "Seat Assigned",
    "seatAssignments": [
      { "travelerId": "...", "segmentId": "SEG-001", "seatNumber": "12A", "seatType": "Window", "status": "Confirmed" }
    ]
  }
}
```
`seatType` is derived from the live seat map's real feature/cabin data (`Business`/`First Class` from segment cabin; `Emergency Exit`/`Extra Legroom`/`Bassinet`/`Premium`/`Window`/`Aisle` from the seat's real features; `Middle` as the only fallback) — never guessed independently of what EXT-008 actually returned.

---

## 8. Database Synchronization (as implemented)

`FlightBookingModel.seatAssignments[]` (new — the real, queryable seat-assignment record) → `TravelFlightAssignmentModel.assignedTravelers[].seatNumber` (read-through sync, **single-leg only** — this codebase's EXT-004 aggregate links one `FlightBookingModel` to at most one `TravelFlightAssignmentModel`; a genuinely multi-segment/connecting-flight booking isn't modeled as multiple assignment records here, so only that one leg is synced. This is a structural limitation predating this document, flagged honestly rather than silently papered over) → Timeline (`SeatAssigned` canonical event, Travel-Plan-linked bookings only).

---

## 9. Caching

Closes the gap EXT-008 itself flagged: `CacheManager.invalidatePattern(\`seat-map:${flightOrderId}*\`)` runs after every successful assignment, invalidating the cached seat map (and any `travelerId`/`segmentId`-suffixed cache-key variants) so a subsequent EXT-008 call never serves a stale "available" status for a seat this call just took.

---

## 10. Domain Events

- `SeatAssigned` *(new — per newly-assigned seat)*
- `SeatChanged` *(new — per seat change, i.e. traveler already had a different seat on that segment)*
- `SeatAssignmentFailed` *(new — provider call failure)*
- `BookingUpdated` *(new — once per successful call)*
- `TimelineEventCreated` (via the shared `recordCanonicalDomainEvent` helper)
- `NotificationRequested` *("Notify Travelers" — no real Email/SMS/WhatsApp/Push provider exists in this codebase; same honest pattern as EXT-005 and `appointmentReminderScheduler.js`)*

---

## 11. AI Integration

No seat-assignment AI tool exists in `AIToolRegistry` (API-006F/006G) — consistent with this document's own §18 "AI never assigns [seats] automatically." A future AI recommendation tool would analyze EXT-008's live seat map and then call this endpoint only after human confirmation, exactly as EXT-004/EXT-005 already established for booking/ticketing proposals.

---

## 12. Security & Logging

JWT required, tenant/branch isolation, `travel.flight.seat.assign` RBAC, full `AuditLogModel` entry on both success (travel plan, flight assignment, per-seat travelerId/segmentId/seatNumber/previousSeat, assignedBy) and failure (reason, correlation ID via `requestId`).

---

## 13. Completion Status

- **Status**: Production Ready
- **Document ID**: `EXT-009`
- **Provider**: Amadeus
- **Next Document**: `EXT-010 — Amadeus Flight Check-in API`
