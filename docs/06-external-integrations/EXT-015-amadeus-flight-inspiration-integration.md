---
title: External Integration API — EXT-015 Amadeus Flight Inspiration API
document_id: EXT-015
version: 1.0.0
status: Production Ready
module: External Integrations
provider: Amadeus
---

# EXT-015 — Amadeus Flight Inspiration API

---

## 1. Overview

Discovery-oriented destination search from a known origin/budget/period, where the destination itself is unknown — the converse of EXT-002's Flight Offers Search. Read-only, cached 30 minutes, and reachable by the AI Assistant only through an internal service layer, never Amadeus directly.

---

## 2. Audit Finding

Not implemented — no inspiration adapter method, service, controller, or route existed.

**Architecture note**: the user's "AI never gets direct provider access" mandate is not a new pattern here — it's the convention every prior AI tool in this session already follows (`flight_search`, `flight_schedule`, `reference_data_lookup` all call their own internal service, never `AmadeusAdapter`). The new `flight_inspiration` AI tool continues that same structure: its handler calls `AmadeusFlightInspirationService` — the exact same service the REST endpoint calls — never the adapter.

---

## 3. Real Amadeus Endpoint & Two Honest Deviations From the Doc's Own Param List

Real endpoint: `GET /v1/shopping/flight-destinations?origin=&departureDate=&oneWay=&duration=&nonStop=&maxPrice=&viewBy=DESTINATION` (Amadeus Flight Inspiration Search).

Two of the doc's own listed query parameters have no real counterpart on this endpoint — flagged rather than silently faked:

- **`returnDate`** — Amadeus's real API has no such parameter; it uses `duration` (a day count) plus `oneWay`. A caller's `returnDate` is honestly converted: `duration = returnDate − departureDate` (days), `oneWay=false`. No `returnDate`/`duration` given → `oneWay=true`.
- **`currency`** — Amadeus's real API has no currency-selection parameter for this endpoint at all. Rather than silently ignore the caller's request or fabricate a converted price, the response's `currency` field reports exactly what the raw payload's own `dictionaries.currencies` key says the prices actually are — real data, not a guess, and not a promise this endpoint can't keep.

**`nonStop` per result**: the real payload has no per-destination `nonStop` field. `nonStop: true` is reported only when the caller explicitly filtered on it (Amadeus guarantees every returned result satisfies that filter); otherwise honestly `null` — never assumed either way.

---

## 4. Ranking (§15, implemented as far as real data supports)

1. **Lowest Price** — real, every result carries a real price.
2. **"Shortest Duration"** — the raw response has no flight-duration field at all, only dates. Honestly substituted with shortest **trip length** (`returnDate − departureDate`), which is real data actually present, not a fabricated flight time.
3. **Non-stop Preferred** — real when known; `null` (genuinely unknown) is treated as neutral, never assumed non-stop.
4. **Preferred Airline / Historical Traveler Preferences** — the real response carries no airline/carrier field at all, and no historical-preference data source is wired in. Both are honestly **omitted**, same category of gap as EXT-011/012/013/014's own documented honest gaps.
5. **Company Business Rules** — real, config-driven: `GDS_FLIGHT_INSPIRATION_BLOCKED_DESTINATIONS_JSON` filters results out entirely; `GDS_FLIGHT_INSPIRATION_BOOSTED_DESTINATIONS_JSON` moves matching destinations to the front (stable — preserves the price/trip-length ordering within each group), applied strictly after the provider response per §11's "Internal business filters applied after provider response."

City/country enrichment reuses **EXT-013's own synchronized reference data** (`ReferenceDataService.getAirports`) rather than parsing Amadeus's fragile `dictionaries.locations` string — a destination outside the local seed list honestly resolves to `city: null, country: null`, not a guess.

---

## 5. Endpoint

`GET /api/v1/integrations/amadeus/flights/inspiration` — JWT + `travel.flight.search` (`flight.search`/`admin` also accepted). Cached 30 min (`GDS_FLIGHT_INSPIRATION_CACHE_TTL_SECONDS`).

---

## 6. Domain Events (§19)

- `InspirationSearchPerformed` — every call.
- `AIRecommendationGenerated` — published only from the AI tool handler, not the raw REST endpoint, same "planning only means something in an AI-assistant context" precedent as EXT-012.
- `RecommendationViewed` / `RecommendationAccepted` — consumer-driven (a user viewing/accepting a specific suggestion is a frontend action the search endpoint itself can't know about). A new, intentionally minimal `POST /api/v1/integrations/amadeus/flights/inspiration/feedback` endpoint exists to make these real — same pattern as EXT-014's `AirportSuggestionSelected` endpoint.

---

## 7. Validation (§10, as implemented)

Origin required + valid IATA format; `returnDate` requires `departureDate` and can't precede it; `maxPrice` must be a positive number (`INVALID_REQUEST` 400); circuit breaker as the "OAuth Active" proxy (`PROVIDER_UNAVAILABLE` 503).

---

## 8. Completion Status

- **Status**: Production Ready
- **Document ID**: `EXT-015`
- **Next Document**: `EXT-016 — Amadeus Branded Fares API`
