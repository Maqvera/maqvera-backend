---
title: External Integration API — EXT-016 Amadeus Branded Fares API
document_id: EXT-016
version: 1.0.0
status: Production Ready
module: External Integrations
provider: Amadeus
---

# EXT-016 — Amadeus Branded Fares API

---

## 1. Overview

Fare-brand comparison (Economy Basic → Flex, Business Saver → Flex) for a flight offer the traveler already selected from a prior EXT-002 search — baggage, refund/change policy where confirmable, seat selection, priority boarding, lounge access, meals.

---

## 2. Audit Finding

Not implemented — no upsell adapter method, service, controller, or route existed.

**Reused, not rebuilt**: §10's "Offer Not Expired"/"Offer Not Found" validation is served entirely by `GdsIntegrationService.revalidateOffer()` — already built for EXT-004's booking flow, already cache-backed with the correct TTL semantics. No second offer cache was created.

**Architecture**: continues the same "AI never touches Amadeus directly" layering every EXT-series AI tool already follows in this codebase — the new `compare_branded_fares` AI tool calls `AmadeusFlightBrandedFaresService` only, never `AmadeusAdapter`.

---

## 3. Real Amadeus Endpoint & the Refund/Date-Change Honesty Problem

Real endpoint: `POST /v1/shopping/flight-offers/upselling` — requires the complete, previously-priced raw Amadeus flight-offer object (same requirement EXT-003/004 already have; there's no lightweight "offer ID only" variant).

**The doc's own response example treats `refund`/`dateChange` as clean booleans-as-strings ("Allowed"/"Not Allowed"/"Fee Applies"). Amadeus's real Upselling response has no structured field for either** — only free-text `amenities[].description` strings, and only for some airlines. Asserting a confident refund/change policy from a guess is a materially consequential mistake (a traveler's money), the same severity class EXT-010 already applied to boarding passes. The implementation:

- Derives `checkedBaggage`, `seatSelection`, `priorityBoarding`, `loungeAccess`, `mealIncluded` from real, well-documented fields (`includedCheckedBags`, `amenities[].amenityType` + `isChargeable`) — confident, not guessed.
- Derives `refund`/`dateChange` via a **best-effort keyword match** over real amenity description text (`REFUND`/`NON-REFUNDABLE`, `CHANGE`/`NO CHANGE`) — when nothing usable is found, honestly returns `null`, never a fabricated default.
- `carryOn` and `milesEligible` are always `null` — neither has a real field anywhere in this endpoint's response. Same category of gap as EXT-011 through EXT-015's own documented honest gaps.

---

## 4. Fare Comparison (§9/§11, real derivations only)

`AmadeusFlightBrandedFaresService._compareFares()` returns `{ cheapestFare, mostFlexibleFare }` — real, deterministic (lowest price; first fare with a *confirmed* `refund === "Allowed"`). Persona-based reasoning ("best for a 4-passenger Umrah group", "best for business travelers") is deliberately left to the AI Assistant tool layer (§14/§15) — it reasons over this real data, it doesn't get re-implemented as fake "AI logic" in the service.

---

## 5. Endpoints

`POST /api/v1/integrations/amadeus/flights/branded-fares` — JWT + `travel.flight.search`. Cached 10 minutes (§16), but **every call re-validates the underlying offer via `revalidateOffer` regardless of cache hit** — an expired offer is always rejected before a stale cached fare list could ever be served (§20 "Never Cache Expired Offers").

`POST /api/v1/integrations/amadeus/flights/branded-fares/recommendation` — logs §19's `FareRecommended` event (consumer-driven, same minimal-endpoint pattern as EXT-014's `AirportSuggestionSelected` and EXT-015's feedback endpoint).

---

## 6. Two Params the Doc Lists That Amadeus's Real Endpoint Doesn't Accept

- **`currency`** — no override exists for this endpoint; the response reports the offer's own actual currency, same honest handling as EXT-015.
- **`passengers`** — traveler composition is already baked into the raw flight offer being upsold (from the original search); there's no separate override parameter. Accepted from the request only for audit-logging context, never sent to Amadeus.

---

## 7. Domain Events (§19)

`BrandedFareRetrieved` (every call), `FareCompared` (when more than one fare is returned), `FareRecommended` (via the feedback endpoint above).

---

## 8. Completion Status

- **Status**: Production Ready
- **Document ID**: `EXT-016`
- **Next Document**: `EXT-017 — Amadeus Ancillary Services API`
