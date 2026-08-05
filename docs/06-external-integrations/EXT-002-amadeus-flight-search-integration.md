---
title: Amadeus Flight Search Integration
document_id: EXT-002
version: 1.0.0
status: Production Ready
module: External Integrations
provider: Amadeus
---

# Amadeus Flight Search Integration

---

## 1. Purpose

Real-time flight search using the Amadeus Self-Service APIs. Travel Operations never stores airline inventory — Amadeus is always the source of truth.

Only Amadeus is enabled today. Sabre/Travelport remain plug-in-ready via the same `BaseGdsAdapter` contract already proven for API-006B–E, but this document — and the endpoint it defines — deliberately talks to Amadeus only, per this phase's own scope decision.

---

## 2. Relationship to API-006B

`GET /api/v1/external/flights/search` (this document) is a **separate, single-provider contract** from `POST /api/v1/flight-search` (API-006B, multi-provider with Amadeus→Sabre failover). They share the same underlying `AmadeusAdapter`, circuit breaker, and validation policy, but return different response shapes:

- API-006B returns the internal offer shape (`offerId`, `price`, `departure`, ...) that Flight Booking (006C), Ticketing (006D), and the AI Tool Registry (006F/006G) already depend on.
- EXT-002 returns the **Standard Flight DTO** below, via a new `FlightOfferMapper` — a real translation layer, not a field rename of the existing shape (renaming it now would be a breaking change across four already-shipped modules).

---

## 3. Responsibilities

### Responsible For
✓ Flight Search ✓ Seat/Fare Availability ✓ Airline/Airport Information ✓ Flight Duration ✓ Cabin Classes ✓ Price Breakdown ✓ Baggage Summary ✓ Live Flight Offers

### Not Responsible For
✗ Booking ✗ Ticket Issuance ✗ PNR Management ✗ Check-in ✗ Refunds — those remain in API-006C/006D.

---

## 4. Business Workflow (as built)

```
Employee ──► GET /api/v1/external/flights/search ──► ExternalFlightController
      │
      ▼
Validate Request (origin/destination/dates/passengers/cabin/currency —
same getFlightSearchValidationConfig() policy as API-006B)
      │
      ▼
AmadeusFlightSearchService.search()
      │
      ├── Cache check (CacheManager — Redis when configured)
      ├── Circuit breaker check (shared with API-006B's GdsIntegrationService)
      ├── gdsHttpClient.getAmadeusToken() — Redis-cached OAuth token
      ├── AmadeusAdapter.searchFlights() (with retry)
      ├── FlightOfferMapper → Standard Flight DTO
      └── Apply Internal Filters (nonStop, maxResults)
      │
      ▼
Audit (AuditLogModel) ──► Return Response
```

---

## 5. Endpoint

`GET /api/v1/external/flights/search`

Requires `Authorization: Bearer <JWT>` and the `flight.search` permission (same as API-006B).

### Query Parameters

`origin`, `destination`, `departureDate` (required) · `returnDate`, `adults`, `children`, `infants`, `travelClass` (`ECONOMY`/`PREMIUM_ECONOMY`/`BUSINESS`/`FIRST`), `nonStop`, `currency`, `maxResults`

### Example
```
GET /api/v1/external/flights/search?origin=KHI&destination=JED&departureDate=2026-10-15&adults=4&travelClass=ECONOMY
```

---

## 6. Validation Rules (as implemented)

Origin required · Destination required · Departure date required · Origin ≠ Destination (structural IATA-format check — no bundled global airport reference table exists in this codebase, and a handful of fake airport rows would be worse than an honest format check) · Departure cannot be in the past (nor beyond a configurable max-advance window) · Adults ≥ 1 · Maximum passengers configurable (`GDS_MAX_PASSENGERS`, shared with API-006B).

---

## 7. Standard Flight DTO (as built — `FlightOfferMapper`)

```
FlightOffer
  ├── provider              "Amadeus"
  ├── providerOfferId
  ├── airline / airlineCode / flightNumber
  ├── origin / destination
  ├── departureTime / arrivalTime / duration
  ├── cabin
  ├── availableSeats
  ├── baggage
  ├── totalPrice / currency
  ├── fareType
  ├── refundable
  ├── segments               (always an array, ≥1 entry)
  └── rawProviderData         real raw Amadeus item when live data was used,
                               or an explicit { source: "dynamic-sandbox", note }
                               object when no live AMADEUS_CLIENT_ID/SECRET is
                               configured — never presented as if it came from
                               the real provider.
```

---

## 8. Authentication (as implemented)

OAuth2 Client Credentials → Access Token → **`CacheManager`** (Redis when `REDIS_URL` is configured, in-memory fallback otherwise) → automatic refresh ~60s before expiry → reused across every call until then. This replaced a per-process in-memory `Map` that meant every server instance (and every restart) re-authenticated from scratch — the token is now genuinely shared where Redis is available, matching this document's own §12 diagram exactly.

---

## 9. Error Handling & Rate Limiting (as implemented)

`gdsHttpClient.requestAmadeus` now retries with real exponential backoff (`GDS_AMADEUS_HTTP_MAX_RETRIES`, `GDS_AMADEUS_HTTP_BACKOFF_BASE_MS`), detecting HTTP 429 distinctly from other failures and publishing `ProviderRateLimited` (vs. `ProviderTimeout` for a real request timeout). Internal clients never see a raw Amadeus error — `ExternalFlightController` maps any failure to a business-safe message, with a distinct `503` when the shared circuit breaker is open.

---

## 10. Business Rules (as implemented)

Live search only — no local flight inventory table exists anywhere in this codebase. Cache TTL is now **configurable** (`GDS_SEARCH_CACHE_TTL_SECONDS`, default 600s) — previously a hardcoded `10 * 60 * 1000` literal shared by both the flight and hotel search caches, fixed as part of this document's own "no cached fares longer than configured TTL" rule.

---

## 11. Metrics (as implemented — `AmadeusMetricsService`)

`GET /api/v1/external/flights/metrics` returns: Search Count, Average Response Time, Provider Availability %, Timeout Rate %, Failed Searches, Cache Hit Rate %, OAuth Refresh Count. In-memory, per-process counters — the same honesty scope as the circuit breaker's own state (real numbers for this running instance; a persisted, cross-instance metrics backend is a separate, larger undertaking not built here).

---

## 12. Domain Events

- `FlightSearchPerformed`
- `ProviderCalled`
- `ProviderTimeout`
- `ProviderRateLimited`
- `FlightSearchCompleted`

---

## 13. AI Coding Rules Summary

✓ Adapter Pattern ✓ Provider Isolation (Amadeus-only path, no Sabre fallback here) ✓ DTO Mapping (`FlightOfferMapper`) ✓ OAuth Token Cache (Redis-backed) ✓ Retry Policy (exponential backoff) ✓ Circuit Breaker Ready (shared instance with API-006B) ✓ No Vendor Lock-in (`BaseGdsAdapter` contract unchanged) ✓ Read-Only Search ✓ No Business Logic In Controller

---

## 14. Completion Status

- **Status**: Production Ready
- **Document ID**: `EXT-002`
- **Provider**: Amadeus
- **Next Document**: `EXT-003 — Amadeus Flight Pricing API`
