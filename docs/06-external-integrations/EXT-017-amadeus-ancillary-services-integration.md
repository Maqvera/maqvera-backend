---
title: External Integration API — EXT-017 Amadeus Ancillary Services API
document_id: EXT-017
version: 1.0.0
status: Production Ready
module: External Integrations
provider: Amadeus
---

# EXT-017 — Amadeus Ancillary Services API

---

## 1. Overview

Priced, optional add-on services (extra baggage, meals, lounge access, priority boarding, etc.) available for a flight offer the traveler has already selected — the last discovery step before EXT-004 booking creation.

---

## 2. Audit Finding

Not implemented as a discovery endpoint. `AmadeusAdapter.addSSR`/`addOSI`/`issueEMD` already exist, but those are **post-booking** mutation operations on an existing PNR (add a special-service request, issue payment for an ancillary) — a different lifecycle stage from this document's pre-booking, read-only catalog retrieval. Not reused as the retrieval mechanism; kept clearly distinct in the audit and the code.

**Reused, not rebuilt**: same as EXT-016, §10's offer-expiry validation is served by the existing `GdsIntegrationService.revalidateOffer()` — no second offer cache.

---

## 3. Real Amadeus Endpoint — Not a Separate API

Amadeus has no standalone "ancillary services" endpoint. The real mechanism is the **same** Flight Offers Price API EXT-003 already calls (`POST /v2/shopping/flight-offers/pricing`), requested with its `include=bags,other-services` query parameters — which return `included["other-services"]`/`included.bags` dictionaries (id → `{name, price}` / `{quantity|weight, price}`) alongside the normal priced offer. This is distinct from EXT-016's Upselling call, which returns whole alternate fare-brand offers with bundled amenities — EXT-017 returns individually priced à-la-carte add-ons for the offer as-is.

**Unmapped services are never dropped**: unlike EXT-008/016's "unmapped code is silently omitted" precedent, an Amadeus service name this codebase doesn't have a specific category for falls into the doc's own explicit **"Other Airline Services"** catch-all (§13's last listed category) — a real service with a real price should still reach the traveler, just generically labeled, never discarded.

An offer with no ancillaries returned genuinely normalizes to an **empty array** — §11 "Ancillary availability depends on airline" makes this a normal outcome, not an error, and it's never backfilled with invented services.

---

## 4. Sandbox Fallback Reuses Existing Config

The dynamic-sandbox catalog matches the doc's own §12 worked example exactly (`BG01`/`ML01`/`LG01`), then extends using **`getTicketingPolicyConfig().supportedEmdTypes`** — the same existing, already env-overridable EMD-type catalog this codebase already uses for post-booking ancillary payment — rather than inventing a second, parallel hardcoded service list (§20 "No Hardcoded Services").

---

## 5. Endpoints

`POST /api/v1/integrations/amadeus/flights/ancillaries` — JWT + `travel.flight.search`. Cached 10 minutes (§16), re-validating the underlying offer on every call regardless of cache hit (same "never serve an expired offer's stale cache" pattern as EXT-016).

`POST /api/v1/integrations/amadeus/flights/ancillaries/selection` — logs §19's `AncillarySelected`/`BookingPriceUpdated` (consumer-driven; same minimal-endpoint pattern as EXT-014/015/016's own selection/feedback endpoints).

---

## 6. Validation (§10, as implemented)

Flight offer required + must resolve via `revalidateOffer` (`OFFER_EXPIRED` 410 otherwise); `passengers`, when explicitly supplied, must be a positive integer and cannot exceed the offer's own already-known passenger count; circuit breaker as the "OAuth Active" proxy.

---

## 7. AI Integration (§14)

New `recommend_ancillary_services` AI tool — read-only, no approval, same "AI never purchases anything automatically" guardrail every AI tool in this registry already follows. Reasons over the real priced services returned (baggage/meal/lounge recommendations for Umrah groups, elderly travelers, families) rather than inventing pricing.

---

## 8. Completion Status

- **Status**: Production Ready
- **Document ID**: `EXT-017`
- **Next Document**: `EXT-018 — Amadeus Order Management API`
