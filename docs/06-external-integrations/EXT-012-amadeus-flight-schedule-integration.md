---
title: External Integration API — EXT-012 Amadeus Flight Schedule API
document_id: EXT-012
version: 1.0.0
status: Production Ready
module: External Integrations
provider: Amadeus
---

# EXT-012 — Amadeus Flight Schedule API

---

## 1. Overview

Read-only, planned (unpriced) flight schedule lookup for a future origin/destination/date — used for itinerary planning, AI recommendations, and operational preparation. Distinct from EXT-011 (real-time operational status of one specific flight) and EXT-002 (priced, bookable offers): this returns Amadeus's real scheduled-flight timetable data.

---

## 2. Audit Finding

Nothing implementing flight schedule retrieval existed anywhere in the codebase — no adapter method, service, controller, or route. This document builds the full stack from scratch.

---

## 3. Endpoint

`GET /api/v1/integrations/amadeus/flights/schedules`

Requires `Authorization: Bearer <JWT>` and the `travel.flight.schedule.read` permission (`flight.search` also accepted, matching the AI Assistant's existing `flight_search` tool permission).

### Query Parameters
- `origin`, `destination` (required) — 3-letter IATA airport codes.
- `departureDate` (required, `YYYY-MM-DD`) — must not be in the past, and within `GDS_FLIGHT_SCHEDULE_MAX_ADVANCE_DAYS` (default 365).
- `airlineCode`, `nonStop`, `maxResults` (optional).

---

## 4. Real Amadeus Endpoint & Normalization

Calls Amadeus's real **Flight Availabilities Search API** — `POST /v1/shopping/availability/flight-availabilities`. This is the correct real Self-Service endpoint for unpriced scheduled-flight data by origin/destination/date (distinct from EXT-002's Flight Offers Search, which is priced/bookable, and EXT-011's On-Demand Flight Status, which requires a specific flight number and returns operational timing, not a timetable).

Each response `data[]` entry is one itinerary; its `segments[]` give real per-leg carrier, aircraft, terminal, and marketing-vs-operating-carrier data, which is genuinely normalized (not passed through raw) into this document's schedule DTO, including multi-segment connecting itineraries (`stops`, full per-leg `segments[]` breakdown) and codeshare detection (`operating.carrierCode !== carrierCode`).

Airline full names are resolved via `getAirlineCheckInRegistry()` — the same real airline registry EXT-010 already introduced (EK/QR/TK/SV/PK) — rather than inventing a second hardcoded airline-name map; an unrecognized carrier code falls back to the raw code.

**Deliberately not derived from live data**: `operatingDays`. Amadeus's real response describes exactly one specific date's flight, not a recurring weekly pattern — this codebase has no real data source for a 6–12 month recurring schedule, and guessing one would misrepresent single-date availability as a standing timetable. This field is `null` on every live-sourced row; it's populated only in the dynamic-sandbox generator below, which is clearly labeled synthetic. Same honest-gap category as EXT-011's Cancelled/Diverted/Returned.

---

## 5. Live vs Dynamic-Sandbox

No live credentials → a deterministic (stable per origin+destination+date, not random per call), clearly-labeled dynamic-sandbox schedule list (`_source: "dynamic-sandbox"`, `_raw.source`), which — unlike the live path — does include a synthetic `operatingDays` pattern, since sandbox data is explicitly allowed to be richer as long as it's honestly labeled. A real call that succeeds but finds no scheduled flights returns a genuine empty `schedules: []` — never silently backfilled with sandbox rows.

---

## 6. Caching

`CacheManager` (Redis or in-memory fallback, same abstraction every other cache in this codebase uses), keyed by tenant + origin + destination + date + filters, TTL from `GDS_FLIGHT_SCHEDULE_CACHE_TTL_SECONDS` (default 1800 = 30 minutes, per §16 of the source doc). "Cache invalidated automatically" means TTL expiry — there's no write path that could go stale, since this is read-only external timetable data, not a locally-owned record.

---

## 7. Validation Rules (as implemented)

| Doc rule | Implementation |
|---|---|
| Origin/Destination Required | `INVALID_REQUEST` 400 |
| Valid IATA Airport Codes | Regex `^[A-Z]{3}$` (same structural-only check as `FlightSearchController.js` — no bundled global airport reference table exists in this codebase, and fabricating one would be worse than an honest format check) |
| Travel Date Valid | Format + not-in-the-past + within `maxAdvanceBookingDays` |
| OAuth Active | Shared `GdsIntegrationService.circuitBreaker` check → `PROVIDER_UNAVAILABLE` 503 |
| Same Tenant | `tenantId` required by controller → 403 if absent |

---

## 8. AI Integration (as implemented)

A new `flight_schedule` tool was registered in `services/ai/AIToolRegistry.js` (`riskLevel: "read"`, `requiresApproval: false`, same read-only guardrail every other AI tool in this registry follows — "AI never books flights"). Its handler calls this same service and returns an `insights` object with real, deterministically-computed fields over the actual schedule data returned: `shortestFlightNumber`, `leastStopsFlightNumber`, `overnightFlightNumbers` (crosses midnight or departs 22:00–04:00 UTC), `businessFriendlyFlightNumbers` (departs 06:00–21:00, not overnight), `airlinesCompared`. This is genuine sorting/filtering logic, not a fabricated model output — "AI analyzes schedule data only" is enforced by construction, since the tool never calls a booking/write service.

---

## 9. Domain Events

- `FlightScheduleRetrieved` — published by the service on every successful lookup (raw REST hit or AI tool call alike).
- `PlanningStarted`, `AIRecommendationGenerated` — published only from the `flight_schedule` AI tool handler, not the raw REST endpoint, since "planning"/"recommendation" semantics genuinely only exist in an AI-assistant invocation context; publishing them on every plain REST poll would misrepresent what happened.

---

## 10. Security & Logging

JWT required, tenant isolation, `travel.flight.schedule.read` RBAC, full `AuditLogModel` entry on both success and provider failure (origin, destination, date, count/source or failure code, correlation ID via `requestId`).

---

## 11. Completion Status

- **Status**: Production Ready
- **Document ID**: `EXT-012`
- **Provider**: Amadeus
- **Next Document**: `EXT-013 — Amadeus Airport & Airline Reference Data API`
