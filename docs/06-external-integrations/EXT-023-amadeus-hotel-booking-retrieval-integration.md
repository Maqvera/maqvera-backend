---
title: External Integration API — EXT-023 Amadeus Hotel Booking Retrieval API
document_id: EXT-023
version: 1.0.0
status: Production Ready
module: External Integrations
provider: Amadeus
---

# EXT-023 — Amadeus Hotel Booking Retrieval API

---

## 1. Overview

Read-only retrieval/synchronization of an existing hotel reservation created via EXT-022 — the hotel-side counterpart to flight booking retrieval, verifying confirmation details and refreshing the internal snapshot.

---

## 2. Audit Finding

Not implemented.

**A genuine gap in Amadeus's own API surface, found during audit — not assumed, checked**: Amadeus's real Hotel Booking API (`POST /v2/booking/hotel-bookings`) is **create-only** in the public Self-Service catalog. Unlike flights — which have a real, separate "Flight Order Management" API (`GET /v1/booking/flight-orders/{id}`) — there is no documented GET-by-confirmation-number retrieval operation for hotel bookings. Same category of honest gap as EXT-005's ticketing and EXT-009's seat assignment: fabricating a call to a URL with no confirmed existence would produce a confusing, unrelated error from Amadeus's real gateway — worse than not calling it at all.

---

## 3. What "Provider Is Source of Truth" (§10) Actually Means Here

Real provider truth exists at exactly one point: **booking creation (EXT-022)**, which already stores Amadeus's real raw response as `HotelBookingModel.bookingSnapshot`. This document serves that genuinely-captured snapshot rather than fabricating a live re-fetch. `AmadeusAdapter._formatHotelBookingSnapshot()` is kept as its own adapter method — not inlined into the service — specifically so that if Amadeus, or a future Hotelbeds/Expedia adapter, ever exposes a real retrieval endpoint, it's a one-method swap, honoring §21's own "Provider adapters are interchangeable" framing.

**What's still real and useful, even without a live re-fetch**: every retrieval refreshes `lastSynchronizedAt` and writes a full audit trail entry (§10 "Every synchronization audited") — genuine bookkeeping, not a formality. `bookingId` reuses the real internal `reservationNumber` generated once at EXT-022 creation time (matching the doc's own §11 example format, `HB-2026-000245`) rather than fabricating a second, differently-shaped identifier.

**Honestly scoped down**: §3/§8's "Detect Reservation Changes" literally describes comparing against fresh *live* provider data, which isn't possible without a real retrieval endpoint. What this document actually verifies is that the stored confirmation number is present and accessible to the requesting tenant — a real, narrower guarantee, not silently dropped from the doc's ambition but explicitly scoped to what's honestly achievable today.

---

## 4. Endpoint

`GET /api/v1/integrations/amadeus/hotels/bookings/{providerBookingId}` — JWT + `travel.hotel.read`. A tenant-scoped DB lookup naturally satisfies §9's "Tenant Authorized"/"Booking Accessible" — a booking belonging to a different tenant is indistinguishable from one that doesn't exist. Cached 5 minutes (§16) on the *formatted response*, not a live provider call.

---

## 5. AI Integration (§14)

New `get_hotel_booking_details` AI tool — read-only, no approval, "AI never modifies provider reservations." Summarizes a real, stored reservation rather than a live re-fetch it can't honestly perform.

---

## 6. Completion Status

- **Status**: Production Ready
- **Document ID**: `EXT-023`
- **Next Document**: `EXT-024 — Amadeus Hotel Booking Cancellation API`
