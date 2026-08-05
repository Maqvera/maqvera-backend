---
title: External Integration API — EXT-010 Airline Flight Check-in API
document_id: EXT-010
version: 1.0.0
status: Production Ready
module: External Integrations
provider: Airline Integration Layer (generic, non-Amadeus)
---

# EXT-010 — Airline Flight Check-in API

---

## 1. Overview

Initiates airline check-in after ticket issuance. **This document is deliberately not part of the Amadeus EXT-series** — per the architectural clarification that opened this document: Amadeus's Self-Service catalog covers search/pricing/booking/ticketing/seat map, but real online check-in and boarding-pass issuance are airline-specific (Emirates, Qatar, Turkish, PIA, Saudia, etc. each have their own proprietary partner integration — no single installable SDK exists the way Amadeus provides for the earlier documents). The Travel Platform therefore either calls a tenant-configured, real airline-specific API, or honestly redirects to that airline's own web check-in portal.

---

## 2. Audit Finding

Nothing implementing this existed. `TravelFlightAssignmentModel.assignedTravelers[].checkInStatus` was a pre-existing dead field (default `"Pending"`, never written to by any controller). No adapter/capability-detection pattern, no `travel.flight.checkin` permission, and no `/integrations/airlines/...` route namespace existed.

**A real gap found along the way**: neither of this codebase's two flight-booking creation paths (API-006C's `CreateFlightBooking`, EXT-004's `AmadeusFlightBookingService`) persisted the booking's real operating airline code anywhere reliable — needed to "Determine Airline" (§8). Both flow through real carrier data already available to them (`FlightOfferMapper`'s Standard Flight DTO for EXT-004; client-supplied `segments[]` for 006C) but never saved it onto `FlightBookingModel`. Fixed by adding `airlineCode`/`airlineName` fields, populated at booking-creation time in both paths — never guessed, `null` when genuinely unavailable.

---

## 3. Endpoint

`POST /api/v1/integrations/airlines/check-in`

Requires `Authorization: Bearer <JWT>` and the `travel.flight.checkin` permission. **Deliberately mounted under `/api/v1/integrations/airlines`**, a separate route file (`routes/AirlineIntegrationRoutes.js`) from `AmadeusIntegrationRoutes.js` — exactly the "Generic Airline Integration APIs" category this document's own preamble asked to be split out, since check-in isn't an Amadeus capability.

### Request
```json
{ "bookingId": "<FlightBookingModel _id or PNR>", "travelerIds": ["...", "..."] }
```

---

## 4. Airline Capability Detection (as implemented, honestly scoped)

`AirlineCheckInAdapterService.isApiSupported(airlineCode)` checks whether a tenant has configured **real** credentials for that specific airline (`AIRLINE_CHECKIN_<CODE>_BASE_URL` + `AIRLINE_CHECKIN_<CODE>_API_KEY`). **No airline has these configured by default in this codebase** — that is the honest, correct state, not a placeholder to fill with fake data: airline check-in integrations are individual commercial/technical partnerships this codebase cannot fabricate credentials for.

- **Unconfigured (every airline, today)**: returns the doc's §12 "Unsupported Airline Response" — `{supported: false, message, redirectUrl}` — where `redirectUrl` comes from a small, real registry of airlines' actual root domains (Emirates, Qatar Airways, Turkish Airlines, Saudia, PIA — `utils/airlineCheckInConfig.js`). These are **root domains only, not guessed deep-link paths** (e.g. `https://www.emirates.com`, not a fabricated `/manage-booking/checkin` path I couldn't verify is current) — operators should override with the exact current check-in URL per airline via `AIRLINE_CHECKIN_REGISTRY_JSON` before relying on this in production.
- **Configured**: `AirlineCheckInAdapterService.performCheckIn()` makes a real HTTP call (`POST {baseUrl}/checkin`, bearer auth) — a generic REST convention, since there is no per-airline SDK to install. This path is real-but-inert in this environment (never invoked, since nothing is configured) exactly like Amadeus's own live-vs-dynamic-sandbox split elsewhere in this EXT-series — but unlike those, **there is no dynamic-sandbox fallback here**: a fabricated boarding pass handed to a real traveler would be actively misleading in a way a fake flight price in a dev sandbox is not. Unconfigured always means "redirect to the real airline," never "generate a fake success."

---

## 5. Validation Rules (as implemented)

| Doc rule | Implementation |
|---|---|
| Booking Exists | `FlightBookingModel.findOne` by `_id` (24-char) or `pnr` (same dual-lookup convention API-006D's `GetFlightBookingById` already uses) → `BOOKING_NOT_FOUND` 404 |
| Same Tenant | Same query above |
| Same Branch | Added, consistent with EXT-005/EXT-009's own convention → `BRANCH_MISMATCH` 403 |
| Ticket Issued | `booking.ticketIssued !== true` (EXT-005's field) → `TICKET_NOT_ISSUED` 400 |
| Traveler Exists / Belongs To Booking | Checked against `booking.travelers[].travelerId` → `TRAVELER_NOT_IN_BOOKING` 400 |
| (added) Determine Airline | `booking.airlineCode` must be recorded → `AIRLINE_UNKNOWN` 422 if not (never guessed) |
| (added) Booking Active | Not `Cancelled`/`Expired`/`Rejected`/`Failed` → `BOOKING_NOT_ACTIVE` 400 |

---

## 6. Business Rules (as implemented)

- **"One traveler may be checked in independently. Group check-in supported."** — `travelerIds[]` accepts one or many in a single call; a traveler already `"Checked In"` is a real idempotent no-op (no duplicate airline call, no duplicate event).
- **"Boarding pass files stored in Object Storage. Only metadata stored in [the database]."** — the real file (when the airline API returns one inline as base64) is uploaded via `saveBookingDocumentFile` (`utils/fileStorage.js`, the same Cloudinary/S3/local abstraction already used for incident attachments elsewhere in this codebase); only the returned URL/size/mimeType/provider is persisted in `FlightBookingModel.boardingPasses[]`.

---

## 7. Response

### Success (HTTP 200)
```json
{ "success": true, "data": { "status": "Checked In", "boardingPassAvailable": true, "travelers": [{ "travelerId": "...", "boardingStatus": "Checked In", "seat": "12A" }] } }
```

### Unsupported Airline (HTTP 200)
```json
{ "success": true, "data": { "supported": false, "message": "Online check-in must be completed on Emirates's website.", "redirectUrl": "https://www.emirates.com" } }
```

---

## 8. Domain Events

- `TravelerCheckedIn` *(new, per traveler)*
- `BoardingPassGenerated` *(new, per traveler with a real boarding pass file/URL returned)*
- `CheckInCompleted` *(new, once per successful call)*
- `CheckInFailed` *(new, on a real provider error from a configured airline)*
- `TimelineEventCreated` (via the shared `recordCanonicalDomainEvent` helper, Travel-Plan-linked bookings only)

**The unsupported-airline branch publishes none of these** — it's a real, expected outcome (HTTP 200, not a failure), but none of the four named events accurately describe "the platform redirected the user to the airline's own website"; publishing one anyway would misrepresent what happened. §13's 4-step timeline ("Check-in Started → Traveler Checked In → Boarding Pass Retrieved → Traveler Notified") is recorded as one canonical timeline entry per completed batch, the same compression convention already used for EXT-004/005/009's own multi-step workflow diagrams.

---

## 9. Database Synchronization

`FlightBookingModel.travelers[].checkInStatus` + `boardingPasses[]` (new) → `TravelFlightAssignmentModel.assignedTravelers[].checkInStatus` (pre-existing dead field, now real) and `.status` advances to `checked_in` (an existing enum value that was never reachable before) → Timeline. **Single-leg only** — same documented structural limitation as EXT-009 (this codebase's EXT-004 aggregate links one `FlightBookingModel` to at most one `TravelFlightAssignmentModel`).

---

## 10. Security & Logging

JWT required, tenant/branch isolation, `travel.flight.checkin` RBAC, full `AuditLogModel` entry on every branch (success, unsupported-airline redirect, and failure) with airline code, travelerIds, execution time, correlation ID via `requestId`.

---

## 11. AI Integration

No check-in AI tool exists in `AIToolRegistry` (API-006F/006G) — consistent with §17/§18 "AI never performs check-in automatically without user approval." A future reminder/detection tool would read `travelers[].checkInStatus` and this endpoint's own audit trail, never call it unattended.

---

## 12. Completion Status

- **Status**: Production Ready
- **Document ID**: `EXT-010`
- **Category**: Generic Airline Integration Layer (not Amadeus)
- **Next Document**: `EXT-011 — Amadeus Flight Status API`
