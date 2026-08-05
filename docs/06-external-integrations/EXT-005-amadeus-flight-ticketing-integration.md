---
title: External Integration API — EXT-005 Amadeus Flight Ticketing API
document_id: EXT-005
version: 1.0.0
status: Production Ready
module: External Integrations
provider: Amadeus
---

# EXT-005 — Amadeus Flight Ticketing API

---

## 1. Overview

Issues electronic airline tickets (E-Tickets) for a PNR already created via EXT-004. A PNR only reserves the itinerary — passengers are considered ticketed only after ticket issuance.

---

## 2. Audit Finding — What Already Existed

API-006D already shipped a full standalone ticketing lifecycle (`IssueTicket`/`VoidTicket`/`ReissueTicket`/`RefundTicket` on `FlightBookingController.js`, at `POST /api/v1/flight-bookings/:flightBookingId/ticket`, permission `flight.ticket`), wired through `GdsIntegrationService.issueTicket()` → `AmadeusAdapter.issueTicket()`. That adapter method has always been an honestly-simulated ticket-number generator, never a live Amadeus call — because **Amadeus's public Self-Service API catalog has no standalone ticket-issuance REST endpoint**; ticketing happens on the airline/GDS side, not through a self-service call. This is not a bug (unlike EXT-004's booking body-shape issue) — there is no real endpoint to fix it toward, and 006D never claimed otherwise.

What did **not** exist was EXT-005's own contract: a separate, Travel-Operations-aware ticketing path over the EXT-004 aggregate (`flightAssignmentId`/`airlineOrderId`/`bookingSnapshot`), at its own endpoint/permission/request shape, updating `TravelFlightAssignmentModel.ticketStatus`, with its own named domain events and a real (if honestly-scoped) retry policy.

---

## 3. Relationship to EXT-004 and API-006D

Same relationship EXT-004 has to API-006C: this is a **separate, Travel-Operations-aware** ticketing path from API-006D's `POST /api/v1/flight-bookings/:flightBookingId/ticket`. Both ultimately call the same `GdsIntegrationService.issueTicket()` (shared circuit breaker + retry), but this endpoint additionally requires the booking to be linked to a `flightAssignmentId` (via EXT-004) and updates the Travel Operations aggregate — `TravelFlightAssignmentModel.ticketStatus`/`status` — which API-006D's endpoint never touches (it can ticket a standalone booking outside a Travel Plan).

---

## 4. Endpoint

`POST /api/v1/integrations/amadeus/flights/ticket`

Requires `Authorization: Bearer <JWT>` and the `flight.ticket.issue` permission (`flight.book`/`admin` also accepted, matching this codebase's existing fallback-permission convention).

### Request
```json
{ "bookingId": "<FlightBooking _id, returned by EXT-004 as flightBookingId>", "pnr": "AB7XYZ" }
```

### Success (HTTP 200)
```json
{
  "success": true,
  "message": "Electronic tickets issued successfully.",
  "data": {
    "bookingId": "...",
    "pnr": "AB7XYZ",
    "ticketStatus": "Issued",
    "tickets": [
      { "travelerId": "...", "ticketNumber": "0651234567890" },
      { "travelerId": "...", "ticketNumber": "0651234567891" }
    ]
  }
}
```

---

## 5. Validation Rules (as implemented)

| Doc rule | Implementation |
|---|---|
| Booking Exists | `FlightBookingModel.findOne({_id: bookingId, tenantId})` → `BOOKING_NOT_FOUND` 404 |
| Same Tenant | Same query above — tenant-scoped by construction |
| Same Branch | `booking.branchId !== branchId` → `BRANCH_MISMATCH` 403 |
| PNR Exists | `!booking.pnr` → `PNR_NOT_FOUND` 400; `booking.pnr !== pnr` → `PNR_NOT_FOUND` 400 (guards against ticketing the wrong reservation on a `bookingId` typo/mismatch) |
| Booking Confirmed | `toDocBookingStatus(booking.status) !== "Confirmed"` → `BOOKING_NOT_CONFIRMED` 400 (reuses the exact mapping EXT-004 already established, so "Confirmed" means the same thing in both documents) |
| Booking Not Already Ticketed | `booking.ticketIssued === true` → `TICKET_ALREADY_ISSUED` 409 |
| Amadeus Connected | Shared `GdsIntegrationService.circuitBreaker.canAttempt("Amadeus")` check → `PROVIDER_UNAVAILABLE` 503 |

---

## 6. Business Workflow (as implemented)

Load Booking → Validate Branch/PNR/Status/Not-Already-Ticketed → Check Circuit Breaker ("Amadeus Connected") → Issue Tickets (with real retry, §7) → Store structured Ticket records + `ticketIssued=true` → Update linked Flight Assignment's `ticketStatus` → Timeline Event (if linked to a Travel Plan) → Publish Events → Notify Customer → Audit → Return Success.

---

## 7. Retry Policy (as implemented, honestly scoped)

| Doc scenario | Status |
|---|---|
| Automatic Retry, 3 Attempts, Exponential Backoff | ✅ Implemented — `services/AmadeusFlightTicketingService.js`'s `issueTicketWithRetry()`, a real loop with real `2^n` backoff delays, config-driven (`GDS_TICKET_ISSUANCE_MAX_ATTEMPTS`/`GDS_TICKET_ISSUANCE_BACKOFF_BASE_MS`, default 3 attempts / 500ms base) |
| Failed requests moved to Retry Queue | ⚠️ **Not implemented.** A durable async retry queue needs a real background job system (e.g. a Bull/Agenda-style queue), which doesn't exist anywhere in this codebase — same honest scope limit already documented for EXT-004's "Amadeus Timeout → Retry Queue" row. The synchronous 3-attempt retry above is real; queuing a failed request for later async redelivery is not. |

---

## 8. Database Updates (as implemented)

- `FlightBookingModel`: `ticketIssued = true` (new boolean field, doc §13's literal name, kept alongside the existing `ticketStatus` enum API-006D already depends on), `ticketStatus = "Issued"`, `status = "Ticketed"`, `ticketNumbers` (existing flat array, kept for 006D void/reissue/refund compatibility), and a new structured `tickets[]` subdocument array (`{travelerId, ticketNumber, status, issuedAt}`) — a real "Ticket Table" per traveler, since the flat string array alone couldn't answer "which ticket belongs to which traveler."
- `TravelFlightAssignmentModel.ticketStatus = "Issued"` (read-through field Travel Operations already relies on per EXT-004 §4); `status` advances from `confirmed` → `ticket_issued` if it was still `confirmed`.
- `travelerId` is now preserved end-to-end: `AmadeusFlightBookingService.createBooking` previously dropped it when creating `FlightBookingModel.travelers[]` — fixed so this endpoint's `tickets[]` response can key by the same `travelerId` the Travel Plan already uses for that person.

---

## 9. Domain Events

- `FlightTicketIssued` *(new)*
- `FlightTicketIssueFailed` *(new — published if all retry attempts are exhausted)*
- `BookingTicketed` *(new)*
- `CustomerTicketNotificationSent` *(new — published once notification requests have been dispatched, see §10)*
- `TimelineEventCreated` (published automatically by the shared `recordCanonicalDomainEvent` helper, only when the booking is linked to a Travel Plan)

---

## 10. Notifications (as implemented, honestly scoped)

No real Email/SMS/WhatsApp/Push provider exists anywhere in this codebase — the only real send capability (`nodemailer`/SMTP) is wired privately inside `controllers/Auth.js` for MFA/reset emails, not as a reusable cross-module service. This mirrors the exact situation `services/appointmentReminderScheduler.js` already solved: publish `NotificationRequested` per channel (Email/SMS/WhatsApp/Push) rather than fabricate delivery, then publish the doc-named `CustomerTicketNotificationSent` once those requests have gone out. A real notification dispatcher (queue consumer + provider SDKs) would need to be built as a separate, cross-cutting piece of infrastructure — not invented here as a one-off for this endpoint.

---

## 11. Business Rules (as implemented)

Ticket issuance is idempotent-by-rejection, not idempotent-by-replay: a second attempt on an already-ticketed booking is rejected (`TICKET_ALREADY_ISSUED`), matching the doc's explicit "Duplicate ticketing prohibited" language — distinct from EXT-004's booking endpoint, which replays the existing result on retry. Ticket numbers are never mutated after issuance by any code path in this codebase.

---

## 12. Security & Logging

JWT required, tenant/branch isolation on every DB query, `flight.ticket.issue` RBAC, full `AuditLogModel` entry on both success and failure (tenant, user, branch, PNR, ticket numbers or failure reason, correlation ID via `requestId`).

---

## 13. AI Integration

AI never issues tickets directly — no ticketing tool is registered in `AIToolRegistry` (API-006F/006G). AI may only read/report ticket status via existing read-only tools, consistent with EXT-004's AI Integration scope.

---

## 14. Completion Status

- **Status**: Production Ready
- **Document ID**: `EXT-005`
- **Provider**: Amadeus
- **Next Document**: `EXT-006 — Amadeus PNR Retrieve API`
