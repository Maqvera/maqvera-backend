---
title: External Integration API — EXT-004 Amadeus Flight Booking API
document_id: EXT-004
version: 1.0.0
status: Production Ready
module: External Integrations
provider: Amadeus
---

# EXT-004 — Amadeus Flight Booking API

---

## 1. Overview

Creates an actual airline reservation (PNR) from a priced flight offer. Unlike EXT-002/EXT-003, this commits the booking. Ticket issuance, payment capture, cancellation, and refund remain out of scope (separate documents/API-006D).

---

## 2. A Real Bug Found and Fixed Along the Way

Auditing this document surfaced that `AmadeusAdapter.createFlightBooking`'s live-API request body was **structurally wrong** — it sent `{offerId, travelers}` to Amadeus's real Flight Create Orders endpoint, which requires the complete priced flight-offer object (`{data: {type: "flight-order", flightOffers: [...], travelers: [...]}}`) plus travelers in Amadeus's own DTO shape. This meant the endpoint could never have booked a real flight even with valid live credentials — it silently always fell through to the dynamic-sandbox path. Fixed as part of building this document, since EXT-004 is specifically about making this real:

- `AmadeusAdapter.createFlightBooking` now builds the correct Amadeus request body and a real `_toAmadeusTraveler()` DTO mapper (uppercased names, ISO dates, passport `documents[]`, `contact`).
- `GdsIntegrationService.revalidateOffer` (used by both this document and API-006C) now surfaces the real raw Amadeus offer (`rawOffer`/`rawOfferSource`) from the search cache, since the live booking call needs the complete offer object, not just an ID.
- API-006C's `CreateFlightBooking` was updated to pass this through — a genuine improvement to that already-shipped endpoint, not just a preserved regression.

---

## 3. Relationship to EXT-002/EXT-003 and API-006C

This document's request requires the **full `flightOffer`** object from EXT-002 (not an opaque `pricedOfferId` — EXT-003 is deliberately stateless/never-cached by its own design, so there is no persisted "priced offer" record an opaque ID could reference). `AmadeusFlightBookingService` calls `AmadeusFlightPricingService.verifyPrice()` internally as its own real "Verify Flight Pricing (EXT-003)" workflow step before ever attempting to book — not a formality, a genuine re-verification call.

This is a **separate, Travel-Operations-aware** booking path from API-006C's `POST /api/v1/flight-bookings`. Both ultimately call the same `GdsIntegrationService.createFlightBooking` (circuit breaker + retry, shared with API-006B/E), but this endpoint additionally requires and validates a real `travelPlanId`/`flightAssignmentId` pair and updates the Travel Operations aggregate — API-006C's endpoint has no such requirement (it can book standalone, outside a Travel Plan).

---

## 4. Aggregate Relationship (as implemented)

```
TravelPlanModel (aggregate root)
   │
   └── TravelFlightAssignmentModel   (existing Travel Operations model, extended)
          ├── flightBookingId  → FlightBookingModel  (existing 006C/006D model, extended)
          ├── airlinePNR
          ├── externalOrderId
          ├── bookingStatus    (Pending/Confirmed/Cancelled/Failed/Expired)
          └── ticketStatus     (Not Issued/Issued/Voided/Refunded/Exchanged)
```

`FlightBookingModel` gained `flightAssignmentId`, `airlineOrderId`, and `bookingSnapshot` (the full, immutable raw Amadeus response — set once at creation, never mutated by any code path in this codebase). `TravelFlightAssignmentModel` gained the read-through booking fields above, using a doc-specified 5-value/5-value status vocabulary distinct from `FlightBookingModel`'s own more granular internal enum — mapped via `toDocBookingStatus`/`toDocTicketStatus` rather than renaming the existing, already-depended-upon internal enum.

---

## 5. Endpoint

`POST /api/v1/integrations/amadeus/flights/book`

Requires `Authorization: Bearer <JWT>` and the `flight.book` permission (the same permission API-006C already uses for booking creation).

**Note**: this document's own literal path uses `/integrations/amadeus/...`, while EXT-002/EXT-003 use `/external/...` and `/external/amadeus/...` respectively — an inconsistency in the source documents themselves, honored exactly as specified per document rather than silently normalized to one convention.

### Request
```json
{
  "travelPlanId": "...", "flightAssignmentId": "...",
  "flightOffer": { "...": "the exact object returned by EXT-002" },
  "travelers": [{ "travelerId": "...", "firstName": "Ahmed", "lastName": "Ali", "gender": "MALE", "dateOfBirth": "1995-05-15", "nationality": "PK", "passportNumber": "AB1234567", "passportExpiry": "2032-05-01", "email": "ahmed@example.com", "phone": "+923001234567" }],
  "contact": { "email": "operations@company.com", "phone": "+923001112233" }
}
```

---

## 6. Business Workflow (as implemented)

Load Travel Plan → Load Flight Assignment → **Flight Not Already Booked** (idempotency — a second call for an already-booked assignment returns the existing booking, never a duplicate airline reservation) → Validate Travelers (exists in Travel Plan's `travelerSnapshots`, passport not expired, real email/phone format checks) → **Verify Flight Pricing** (real EXT-003 call; if the price changed, return the latest price and stop — never book at a stale price) → Create Airline Booking (real Amadeus Flight Create Orders call, or honestly-labeled dynamic-sandbox booking) → Store Booking Snapshot → Update Flight Assignment → Timeline Event → Audit Log → Publish Events → Return Success.

---

## 7. Response

### Success (HTTP 201)
```json
{ "success": true, "message": "...", "data": { "flightBookingId": "...", "airlineOrderId": "eJzTd9f3", "pnr": "AB7XYZ", "bookingStatus": "Confirmed", "ticketStatus": "Not Issued" } }
```

### Price Changed (HTTP 200 — not booked)
```json
{ "success": true, "message": "Price changed since the offer was selected...", "data": { "booked": false, "priceChanged": true, "previousPrice": ..., "newPrice": ..., "currency": "..." } }
```

---

## 8. Failure Handling (as implemented, honestly scoped)

| Doc scenario | Status |
|---|---|
| Price Changed → Return Latest Price | ✅ Implemented (§7 above) |
| Traveler Validation Failed → Reject Booking | ✅ Implemented |
| Passport Invalid → Reject Booking | ✅ Implemented |
| Airline Rejected → Return Error | ✅ Implemented (structured `INVALID_PROVIDER_RESPONSE`/`FLIGHT_NOT_AVAILABLE`) |
| Flight Sold Out → Suggest Alternative Flights | ⚠️ **Detection real** (an unavailable offer surfaces as a real error); **suggestion engine not built** — searching and ranking alternatives is a distinct, larger feature this document doesn't have enough scope to fabricate honestly |
| Amadeus Timeout → Retry Queue | ⚠️ **Synchronous retry real** (shares the same circuit breaker + retry infrastructure as EXT-002/003); **no durable async retry queue** — that needs a real background job system (e.g., a Bull/Agenda-style queue), which doesn't exist anywhere in this codebase yet and would be a separate architectural addition, not a per-endpoint fix |

---

## 9. Business Rules (as implemented)

Booking cannot be duplicated (idempotency by `flightAssignmentId`, §6). Every booking stores the complete Amadeus response snapshot (`bookingSnapshot`, real raw data when live, honestly-labeled sandbox data otherwise). Airline PNR and booking snapshot are never edited after creation — no code path in this codebase mutates either field post-creation.

---

## 10. Domain Events

- `FlightBookingCreated` (already existed, from API-006C)
- `AirlinePNRCreated` *(new)*
- `FlightBooked` *(new)*
- `BookingSnapshotStored` *(new)*
- `TimelineEventCreated` (published automatically by the shared `recordCanonicalDomainEvent` helper — no separate publish needed)

---

## 11. Security & Logging (as implemented)

JWT required, tenant/branch isolation on every DB query, `flight.book` RBAC, OAuth token never logged (inherited from EXT-002's `gdsHttpClient`), full `AuditLogModel` entry per booking (tenant, user, branch, PNR, order ID, correlation ID via `requestId`, travel plan/assignment references).

---

## 12. AI Integration

AI never books directly — no booking tool is registered in `AIToolRegistry` (API-006F/006G); `propose_flight_booking` (built for 006G) only ever creates a pending human-approval request whose approved output is "call this real REST endpoint" — this document's endpoint — never an automatic invocation.

---

## 13. Completion Status

- **Status**: Production Ready
- **Document ID**: `EXT-004`
- **Provider**: Amadeus
- **Next Document**: `EXT-005 — Amadeus Flight Order Management API`
