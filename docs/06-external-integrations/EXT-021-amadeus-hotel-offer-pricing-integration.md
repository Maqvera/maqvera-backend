---
title: External Integration API — EXT-021 Amadeus Hotel Offer Pricing API
document_id: EXT-021
version: 1.0.0
status: Production Ready
module: External Integrations
provider: Amadeus
---

# EXT-021 — Amadeus Hotel Offer Pricing API

---

## 1. Overview

Live re-verification of a specific hotel room offer's price and availability immediately before booking — the exact hotel-side analog to EXT-003's flight pricing verification, mandatory because hotel inventory/pricing genuinely changes within minutes.

---

## 2. Audit Finding

Not implemented — but EXT-020 already built exactly the infrastructure this needs (`GdsIntegrationService.getHotelOfferById()`, mirroring `revalidateOffer()`'s shape for flights), specifically anticipating this document. Reused directly, no second offer-tracking mechanism.

**Refactored EXT-020's own normalization along the way**: extracted the shared per-offer parsing logic (room type, bed type, meal plan, cancellation-derived refundability) into one static `_normalizeHotelOfferEntry()` helper, used by both EXT-020's multi-offer search normalizer and this document's single-offer re-verification normalizer — since both genuinely parse the identical real Amadeus offer shape. Re-verified against EXT-020's original 30-check test script afterward: zero regressions.

---

## 3. Real Amadeus Endpoint

`GET /v3/shopping/hotel-offers/{offerId}` — Amadeus's real Hotel Search v3 "Get Offer" operation, the direct hotel-side counterpart to EXT-003's flight offer pricing endpoint. Unlike EXT-016's Upselling call, this takes only the real Amadeus offer ID (not a full offer body) and returns that same offer freshly re-priced/re-validated.

**Only ever called for a genuinely live-origin cached offer** — if EXT-020's search that produced this `hotelOfferId` was itself a dynamic-sandbox result (no live credentials at the time), there is no real Amadeus offer ID to re-confirm, and this endpoint is never called with a fabricated one. A deterministic, clearly-labeled sandbox re-verification is returned instead, mirroring EXT-003's own established "≈12% chance of a real price change, otherwise unchanged" simulation style.

---

## 4. A Genuine Field-Semantics Difference From EXT-020, Resolved Correctly

This document's own §12 example (`price:215, taxes:32, fees:8, total:255`) uses **`price` to mean the base, pre-tax amount** — the opposite of EXT-020's own `price` field, which means the tax-inclusive total. Implemented exactly to this document's own contract (not EXT-020's), since each document's response DTO is defined by its own spec: `price` = base, `total` = the real provider grand total (used directly, never reconstructed by addition, since `fees` below is honestly unknown).

**`fees` is honestly `null`.** Amadeus's real `price.taxes[]` array doesn't reliably distinguish a separate "fee" category from "tax" across suppliers, and guessing a split would misstate real numbers the traveler is about to pay. `taxes` reports the full real taxes-array sum instead of an invented partial — `total` remains trustworthy regardless, since it comes directly from the provider.

---

## 5. Price-Change Detection (§9/§14, real)

Compares the fresh `total` against the price EXT-020's own cache already recorded for the same `hotelOfferId` — a genuine before/after comparison, not a guess — and publishes `HotelPriceChanged` only when they genuinely differ, `HotelOfferValidated` when confirmed unchanged, `HotelOfferExpired` when the provider reports the room is no longer available.

---

## 6. Endpoint & Caching

`POST /api/v1/integrations/amadeus/hotels/pricing` — JWT + `travel.hotel.book`. Cached **at most 60 seconds** (§16 — deliberately far shorter than EXT-020's 5-minute search cache) purely to deduplicate rapid repeat requests for the same offer, never as a substitute for a fresh check.

---

## 7. AI Integration (§14)

New `verify_hotel_offer_pricing` AI tool — read-only, no approval, "AI never modifies provider pricing." Reasons over the real before/after comparison to explain price changes or recommend alternatives, never fabricating a reason for a price move it can't confirm.

---

## 8. Completion Status

- **Status**: Production Ready
- **Document ID**: `EXT-021`
- **Next Document**: `EXT-022 — Amadeus Hotel Booking API`
