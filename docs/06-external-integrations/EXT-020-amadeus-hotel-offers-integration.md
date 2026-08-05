---
title: External Integration API — EXT-020 Amadeus Hotel Offers API
document_id: EXT-020
version: 1.0.0
status: Production Ready
module: External Integrations
provider: Amadeus
---

# EXT-020 — Amadeus Hotel Offers API

---

## 1. Overview

Live, priced room offers for a hotel already discovered via EXT-019 — room type, meal plan, occupancy, and cancellation/refund policy, closing exactly the gap EXT-019 flagged (rating/amenities live here, not in the hotel-discovery response).

---

## 2. Audit Finding

Not implemented. Built as a new, cleanly-scoped capability alongside (not touching) the legacy hotel-distribution pipeline, same precedent as EXT-019.

**Sets up EXT-021 in advance, per the user's own explicit ask** ("jaise humne flights ke liye pricing verification implement ki thi"): `GdsIntegrationService` now has a `hotelOfferCache` (keyed by `offerId`) and a `getHotelOfferById()` lookup, mirroring `revalidateOffer()`'s exact shape for flight offers (`isValid`/`rawOffer`/`rawOfferSource`) — real, working infrastructure EXT-021 can call directly rather than needing to invent its own offer-tracking mechanism.

**A real bug found and fixed along the way, in already-shipped EXT-017 code**: the "Title Case" formatter used for both this document's room-type fallback and EXT-017's "Other Airline Services" catch-all description had a naive capitalize-first-letter implementation that never lowercased the rest of an all-caps provider code, so `"EXECUTIVE_SUITE"` rendered as `"EXECUTIVE SUITE"` instead of `"Executive Suite"`. Caught by this document's own stricter test assertion (EXT-017's original test only checked the category, not the exact casing). Fixed with a shared, correctly-implemented `AmadeusAdapter._toTitleCase()` helper, used at both call sites — re-verified against EXT-017's original 23-check test script afterward, zero regressions, output only improved.

---

## 3. Real Amadeus Endpoint & the "availableRooms" Gap

Real endpoint: `GET /v3/shopping/hotel-offers?hotelIds=&checkInDate=&checkOutDate=&adults=&roomQuantity=&currency=` — Amadeus's real Hotel Search v3 "Hotel Offers" API. This is genuinely where the hotel `rating`/`amenities` EXT-019 honestly left `null` actually live (on `data[].hotel`).

**The doc's own §12 example shows `"availableRooms":8` — Amadeus's real response has no such field.** It prices individual bookable offers; it doesn't expose a remaining-inventory count. Reported honestly as `null` rather than guessed, same category of gap as EXT-013's timezone or EXT-016's carryOn.

`refundable`/`freeCancellationUntil` are genuinely **derived** from the real `policies.cancellations[]` array (a future `deadline` means free cancellation until then) rather than a separate confirmed boolean field, since Amadeus's schema doesn't reliably provide one directly — verified against both a future-deadline (refundable) and past-deadline (non-refundable) fixture.

---

## 4. One Param the Doc Lists With No Honest Path to the Provider

**`children`** — accepted for informational/audit purposes only. Amadeus's real API requires a matching `childAges` array when searching with children, which this document's own §7 query parameters don't collect. Rather than guess placeholder ages, it's never sent to the provider.

---

## 5. Endpoints

`GET /api/v1/integrations/amadeus/hotels/offers` — JWT + `travel.hotel.search`. Cached 5 minutes (§16).

`POST /api/v1/integrations/amadeus/hotels/offers/view` — logs §19's `RoomOfferViewed` (consumer-driven; same minimal-endpoint pattern as every prior EXT document's own selection/feedback endpoints).

---

## 6. AI Integration (§14)

New `get_hotel_room_offers` AI tool — read-only, no approval, "AI never books rooms automatically." Reasons over the real offers/policies returned (best value for a family, Umrah group room recommendations, cancellation-policy explanations) rather than inventing pricing or availability.

---

## 7. Completion Status

- **Status**: Production Ready
- **Document ID**: `EXT-020`
- **Next Document**: `EXT-021 — Amadeus Hotel Offer Pricing API`
