---
title: External Integration API — EXT-019 Amadeus Hotel Search API
document_id: EXT-019
version: 1.0.0
status: Production Ready
module: External Integrations
provider: Amadeus
---

# EXT-019 — Amadeus Hotel Search API

---

## 1. Overview

Live hotel discovery by city or geolocation — the first step of a new, correctly-scoped hotel pipeline (EXT-019 → EXT-025) distinct from this codebase's pre-existing legacy hotel-distribution flow.

---

## 2. Audit Finding

**Partially implemented, and the existing implementation is exactly the kind of problem this whole EXT-series has been fixing.** A pre-existing `AmadeusAdapter.searchHotels()` already calls the real Amadeus Hotel List API (`/v1/reference-data/locations/hotels/by-city`) — but then overlays **fabricated** `stars`, `price`, `roomType`, `mealPlan`, `availableRooms`, `cancellationPolicy` directly onto the real hotel names it retrieves, feeding a separate legacy pipeline (`POST /api/v1/hotel-search` → `/hotel-bookings`) that predates this session's honesty conventions.

**Left untouched, by design** — same precedent as EXT-008 leaving the older pre-booking `getSeatMap()` alone when adding `getFlightOrderSeatMap()`: other code depends on the legacy pipeline, and fixing its fabrication is a separate concern from building this document's own correctly-scoped endpoint. EXT-019 builds a new, separately-named `searchHotelList()` that returns **only** what Amadeus's real response actually contains.

---

## 3. Real Amadeus Endpoint & the Rating/Amenities Gap

Real endpoint: `GET /v1/reference-data/locations/hotels/by-city` (cityCode) or `.../by-geocode` (latitude/longitude/radius) — Amadeus's real **Hotel List API**.

**The doc's own §12 response example shows `rating` and `amenities` — Amadeus's real Hotel List response has neither field.** Those come from the Hotel Offers Search response (this document's own next-in-sequence document, EXT-020), not hotel discovery. Rather than fabricate a star rating or an amenities array, live results honestly report `rating: null, amenities: []` — exactly matching §21's own stated boundary: "Hotel Search only discovers hotels... Room availability, pricing... handled by dedicated APIs."

**`chain` (a friendly brand name) is also honestly `null`** — the real response gives `chainCode` (a 2-letter Amadeus code), but this codebase has no confirmed, complete IATA hotel-chain-code dictionary to translate it from, and guessing a hotel's brand wrong is worse than reporting the real raw code alone. The real `chainCode` itself is preserved.

City/country names are enriched via **EXT-013's own synchronized reference data** (`ReferenceDataService.getCities`) — Amadeus's hotel city codes are the same IATA city codes EXT-013 already syncs — rather than parsing anything from the hotel response itself (which carries no city name field). A city outside the local seed list honestly resolves to `city: null, country: null`.

---

## 4. Two Params the Doc Lists That Have No Real Provider Equivalent

- **`hotelName`** — no confirmed free-text name filter exists on Amadeus's real Hotel List endpoint. Applied as an honest client-side substring filter over the real results instead of guessed at as a provider parameter.
- **`page`/`pageSize`** — Amadeus's real endpoint has no pagination parameters of its own. Implemented as an honest client-side slice over the full result set actually returned (bounded by §10's "Maximum Page Size = 100"), not a fabricated provider capability.

`ratings`/`amenities`/`chainCodes` **are** real, documented query parameters on this endpoint and are forwarded to Amadeus directly.

---

## 5. Endpoints

`GET /api/v1/integrations/amadeus/hotels/search` — JWT + `travel.hotel.search`. Cached 15 minutes (§16).

`POST /api/v1/integrations/amadeus/hotels/search/view` — logs §19's `HotelViewed` (consumer-driven; same minimal-endpoint pattern as EXT-014 through EXT-017's own selection/feedback endpoints).

---

## 6. AI Integration (§14)

New `search_hotel_list` AI tool — deliberately named apart from the pre-existing `hotel_search` tool (which already wraps the legacy priced-availability search) to avoid conflating two different capabilities. Read-only, no approval, matching "AI never books hotels automatically" and the "AI never gets direct provider access" mandate — the tool calls `AmadeusHotelSearchService` only.

---

## 7. Completion Status

- **Status**: Production Ready
- **Document ID**: `EXT-019`
- **Next Document**: `EXT-020 — Amadeus Hotel Offers API (Room Availability & Pricing)`
