---
title: External Integration API — EXT-022 Amadeus Hotel Booking API
document_id: EXT-022
version: 1.0.0
status: Production Ready
module: External Integrations
provider: Amadeus
---

# EXT-022 — Amadeus Hotel Booking API

---

## 1. Overview

Real Amadeus hotel reservation creation — the exact hotel-side counterpart to EXT-004's flight PNR creation. Booking is structurally gated on EXT-021's pricing verification (not just documented as a rule), and deliberately decoupled from Travel Operations per the doc's own DDD note.

---

## 2. Audit Finding

**Not implemented as a real integration.** The pre-existing legacy `AmadeusAdapter.createHotelBooking()` never calls Amadeus at all — it returns a 100% fabricated reservation number for the legacy hotel-distribution pipeline. Left untouched (out of scope, other code depends on it); built a new, separately-named `createHotelBookingReservation()` instead, same precedent as EXT-019/020/021.

**Reused directly, not re-implemented**: EXT-020's offer cache (`getHotelOfferById`) and EXT-021's pricing verification (`AmadeusHotelPricingService.verifyPricing`) are called internally by this booking flow — §11 "Booking allowed only after successful pricing verification" is enforced structurally, the same way EXT-004 already calls EXT-003's pricing service before ever creating a PNR.

**Idempotency reused, not reinvented**: this codebase already has a working, generic `middleware/idempotency.js` (opt-in via an `Idempotency-Key` header, already used on `TravelPlanRoutes.js`/`IncidentRoutes.js`). Applied to the new `POST /hotels/book` route rather than hand-rolling idempotency logic in the service — satisfies §16/§18's explicit requirement with existing, already-tested infrastructure.

**Three real bugs found and fixed during implementation, before they ever shipped:**
1. The sandbox booking generator was `static` but referenced `this.providerName` — an *instance*-only property that would have been `undefined` in a static context. Fixed by having the caller supply `provider` instead (matching EXT-021's own sandbox builder, which never sets it either).
2. A dead code path checked `pricing.meta?.checkInDate`/`checkOutDate` — fields EXT-021's response never actually carries — which could have produced an `Invalid Date`. Fixed to read the real dates from the cached offer, with an explicit validation guard if they're genuinely missing.
3. The service was about to write the **hotel ID** into the booking's `city` field, since neither EXT-019's nor EXT-020's real Amadeus responses carry a city *name* at this point in the flow — only a hotel ID. Fixed by storing `city: null` (honest) instead, and relaxed `HotelBookingModel.city` from `required: true` to optional so this doesn't silently mask the gap for future callers either.

**A fourth issue found via testing, not audit**: the duplicate-booking DB check originally ran *before* the cheap, DB-free offer-cache validation — meaning a garbage/expired offer ID would hang on a database round-trip before ever being rejected. Reordered so pricing verification (which validates the offer via cache, no DB) runs first; the DB is only touched once we already know the request could plausibly succeed.

---

## 3. Real Amadeus Endpoint & Its Honest Boundary

Real endpoint: `POST /v2/booking/hotel-bookings` — Amadeus's real Hotel Booking v2 API.

**This document's own §3 explicitly excludes Payment Processing — but Amadeus's real API requires a `payments` guarantee block for offers under certain rate policies.** Rather than refuse to build the real integration over this, the real request is sent with exactly what this platform actually collects (guests, contact — no `title`/salutation either, since none is collected and none is guessed). If Amadeus's real API rejects a booking for a missing payment guarantee, that surfaces as a genuine, correctly-labeled provider error — never suppressed or faked into a false confirmation.

**§11 "Provider confirmation number is mandatory"** is enforced literally: a real Amadeus response that succeeds but omits a confirmation number is treated as an integrity failure (`INVALID_PROVIDER_RESPONSE`), not silently accepted — mirroring EXT-004's identical treatment of a flight order missing its ID.

---

## 4. Architecture Note — Deliberately Decoupled From Travel Operations

Unlike EXT-004 (which requires a pre-existing `TravelFlightAssignment`), `travelPlanId` here is genuinely **optional** — matching the doc's own explicit DDD note. A hotel reservation can be created standalone; `TravelPlanReadyForHotelAssignment` is published only when a `travelPlanId` was actually supplied (publishing it for a standalone booking would be a nonsensical signal — there's no travel plan to be "ready"). Building the Travel-Operations-side consumer that turns this event into a real Hotel Assignment is **explicitly out of scope** (§3 "Not Responsible For: Room Allocation, Operational Management") — a future document's job, not a shortcut taken here.

---

## 5. Endpoint & AI Integration

`POST /api/v1/integrations/amadeus/hotels/book` — JWT + `travel.hotel.book`, `Idempotency-Key` opt-in.

New `propose_hotel_booking` AI tool — mirrors the existing `propose_flight_booking` tool exactly: creates a pending `AIApprovalRequestModel` row and hands back the real endpoint call for a human to approve; **never books anything itself**, satisfying §14's "AI never creates bookings without explicit user approval" the same way flight booking already does.

---

## 6. Completion Status

- **Status**: Production Ready
- **Document ID**: `EXT-022`
- **Next Document**: `EXT-023 — Amadeus Hotel Booking Retrieval API`
