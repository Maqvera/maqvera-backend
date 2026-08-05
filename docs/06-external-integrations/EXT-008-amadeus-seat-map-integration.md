---
title: External Integration API — EXT-008 Amadeus Seat Map API
document_id: EXT-008
version: 1.0.0
status: Production Ready
module: External Integrations
provider: Amadeus
---

# EXT-008 — Amadeus Seat Map API

---

## 1. Overview

Read-only live seat-map retrieval for an already-confirmed flight order. No seat inventory is ever stored — every response is sourced fresh from Amadeus (or an honestly-labeled dynamic-sandbox fallback), cached only for the doc's own 5-minute TTL. Seat *selection* (actually reserving a seat against the PNR) is out of scope — that's EXT-009.

---

## 2. Audit Finding

`AmadeusAdapter.getSeatMap()` already existed (API-006B, `POST /api/v1/flight-search/seat-map`) but is a **pre-booking preview**, keyed by a raw `flightNumber` string, fully hardcoded (always the same single row `12A`/`12B`), with **zero permission check at all**. It is a distinct feature from this document and was left untouched, out of scope here — EXT-008 is post-booking, keyed by a real `flightOrderId` against a confirmed reservation, and needed its own real implementation from scratch: no caching, no tenant/booking-active validation, no live Amadeus call, no domain events, and no endpoint under `/api/v1/integrations/amadeus/...` existed for it at all.

**A real gap found and fixed along the way**: `FlightBookingModel.airlineOrderId`/`bookingSnapshot` were only ever populated by EXT-004's newer booking path (`AmadeusFlightBookingService`) — the older, still-active API-006C `CreateFlightBooking` endpoint (`controllers/FlightBookingController.js`) never saved them, even though `AmadeusAdapter.createFlightBooking` (fixed in EXT-004) already returns both. This meant a booking created via 006C could never be found by EXT-008's `flightOrderId` lookup. Fixed by adding both fields to 006C's `FlightBookingModel.create()` call, mirroring EXT-004's own convention exactly.

---

## 3. Endpoint

`GET /api/v1/integrations/amadeus/seat-map/:flightOrderId`

Requires `Authorization: Bearer <JWT>` and the `travel.flight.read` permission (`flight.read`/`flight.book`/`admin` also accepted — this codebase's existing booking-read permissions already gate the same underlying `FlightBookingModel`, so an operator who can view a booking can view its seat map too).

### Query Parameters (optional)
- `travelerId` — when present, seat prices reflect that traveler's pricing entry from Amadeus's real per-traveler pricing array.
- `segmentId` — narrows the response to one flight segment.

---

## 4. Validation Rules (as implemented)

| Doc rule | Implementation |
|---|---|
| Valid Flight Order ID | Non-empty `flightOrderId` → `INVALID_REQUEST` 400 |
| Flight Order Exists | `FlightBookingModel.findOne({tenantId, $or: [{airlineOrderId}, {providerBookingReference}]})` → `FLIGHT_ORDER_NOT_FOUND` 404 |
| Same Tenant | Same query above — tenant-scoped by construction |
| Booking Active | `booking.status` not in `Cancelled/Expired/Rejected/Failed` → `BOOKING_NOT_ACTIVE` 400 |

---

## 5. Live vs Dynamic-Sandbox (as implemented, honestly scoped)

`AmadeusAdapter.getFlightOrderSeatMap()` only attempts a real call — `GET /v1/shopping/seatmaps?flight-orderId={id}` (Amadeus's real Seatmap Display API, the GET variant that retrieves a seat map for an *existing* flight order rather than the POST variant used pre-booking) — when the underlying booking's `bookingSnapshot` is itself a real Amadeus order (has a provider `id`, not tagged `dynamic-sandbox`). Otherwise it returns a deterministic (stable per `flightOrderId`, not randomized per call), structured, clearly-labeled sandbox seat map — never a single hardcoded row like the old 006B stub.

Live-response normalization maps Amadeus's real `data[].decks[].seats[]` shape into this doc's `segments[].rows[].seats[]` DTO:
- Seat status: real `seatAvailabilityStatus`/pricing presence mapped to the doc's 6-value enum (`BLOCKED`→`OCCUPIED`, priced/`CH`-coded→`CHARGEABLE`, `AVAILABLE`→`AVAILABLE`, anything else→`UNAVAILABLE` — never optimistically assumed available). `RESERVED` is never produced by this endpoint since holding a seat doesn't exist until EXT-009.
- Features: a real, documented subset of Amadeus's seat-characteristic codes (`W`→Window, `A`→Aisle, `E`→Emergency Exit, `L`/`LS`→Extra Legroom, `1A`→Bassinet, `OW`→Near Wing, `P`→Premium) plus amenity types (`POWER`→Power Outlet, `USB_PORT`→USB). **Unrecognized codes are omitted, never guessed at** — this is why `Middle`/`Near Lavatory`/`Reclining` don't appear in the live mapping: no code in Amadeus's real, documented set was confidently identifiable for them.
- Aircraft: a small real IATA equipment-code dictionary (320→Airbus A320, 738→Boeing 737-800, etc.); an unrecognized code falls back to the raw code (`Aircraft 7M8`) rather than a fabricated name.

---

## 6. Caching (as implemented)

`CacheManager` (Redis when configured, in-memory fallback otherwise — same abstraction every other cache in this codebase uses), key `seat-map:{flightOrderId}[:travelerId][:segmentId]`, TTL from `GDS_SEAT_MAP_CACHE_TTL_SECONDS` (default 300s, matching the doc exactly). This is a short-lived read-through cache, not persistence — nothing else in this codebase ever reads the key back.

**Invalidation** (doc §14 "Cache invalidated after: Seat Selection, Booking Change, Ticket Reissue, Cancellation"):

| Trigger | Status |
|---|---|
| Ticket Reissue | ✅ Wired into API-006D's `ReissueTicket` |
| Cancellation | ✅ Wired into API-006C's `CancelFlightBooking` |
| Booking Change | ✅ Wired into API-006C's `SyncFlightBooking`, only when the provider sync actually changed the booking status |
| Seat Selection | ⚠️ **Not wired — EXT-009 doesn't exist yet.** The invalidation call is a one-line `CacheManager.invalidate()`; EXT-009's implementation should add it, not this document. |

---

## 7. Response

### Success (HTTP 200)
```json
{
  "success": true,
  "message": "Seat map retrieved successfully.",
  "data": {
    "flightOrderId": "...",
    "segments": [
      { "segmentId": "SEG-001", "aircraft": "Airbus A320", "cabin": "Economy",
        "rows": [ { "row": 10, "seats": [ { "seatNumber": "10A", "status": "AVAILABLE", "features": ["Window"] } ] } ] }
    ]
  }
}
```

---

## 8. Domain Events

- `SeatMapViewed` *(new — published on every successful retrieval, cache hit or miss)*
- `SeatSuggestionGenerated` — **deliberately not published by this endpoint.** This is a pure read/normalize endpoint; it has no ranking or recommendation logic. Per doc §13 "AI Usage," seat suggestions ("find the best window seat," "suggest seats together") are the AI Assistant's job, analyzing this endpoint's real output — no such AI tool exists yet in `AIToolRegistry` (API-006F/006G). Publishing this event here, with no actual suggestion behind it, would be exactly the kind of fabrication this codebase's own precedent (EXT-004 §8, EXT-005 §7) explicitly avoids. It belongs to whichever future AI tool actually generates a suggestion.

---

## 9. Security & Logging

JWT required, tenant isolation on every DB query, `travel.flight.read` RBAC, full `AuditLogModel` entry on both success (source: live/dynamic-sandbox, travelerId/segmentId filters) and failure (reason, mapped error code).

---

## 10. Completion Status

- **Status**: Production Ready
- **Document ID**: `EXT-008`
- **Provider**: Amadeus
- **Next Document**: `EXT-009 — Amadeus Seat Selection API`
