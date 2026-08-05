---
title: EXT-003 — Amadeus Flight Pricing API
document_id: EXT-003
version: 1.0.0
status: Production Ready
module: External Integrations
provider: Amadeus
---

# EXT-003 — Amadeus Flight Pricing API

---

## 1. Overview

Verifies the latest live fare for a flight offer selected from EXT-002's search results, before proceeding to booking. Never creates a booking — only validates pricing, taxes, baggage, and fare rules against live Amadeus inventory.

---

## 2. Relationship to EXT-002

The request body's `flightOffer` must be exactly the Standard Flight DTO EXT-002 returns (`provider`, `providerOfferId`, `totalPrice`, `currency`, `rawProviderData`, `searchedAt`). This service passes `flightOffer.rawProviderData` — the real raw Amadeus offer object when EXT-002 ran against live credentials — to Amadeus's actual Flight Offers Price API. When EXT-002 was itself running in dynamic-sandbox mode (no live credentials), `rawProviderData` is the honest `{source: "dynamic-sandbox", ...}` placeholder, and this endpoint falls back to a real, labeled dynamic re-price simulation rather than fabricating a "live" verification of data that was never live to begin with.

---

## 3. Responsibilities

### Responsible For
✓ Live Price Verification ✓ Fare Validation ✓ Tax Validation ✓ Baggage Validation ✓ Fare Rule Retrieval ✓ Seat Availability Validation ✓ Currency Validation ✓ Price Expiry Validation

### Not Responsible For
✗ Flight Search (EXT-002) ✗ Booking ✗ Ticket Issuance ✗ Payment ✗ PNR Creation (EXT-004+)

---

## 4. Endpoint

`POST /api/v1/external/amadeus/flights/pricing`

Requires `Authorization: Bearer <JWT>` and the `travel.external.flight.pricing` permission.

### Request
```json
{ "flightOffer": { "...": "the exact object returned by EXT-002" } }
```

---

## 5. Validation Rules (as implemented)

Flight Offer Required · Flight Offer Must Be Valid (`provider === "Amadeus"`, and `providerOfferId`/`totalPrice`/`currency`/`rawProviderData` all present — structurally, not just presence-checked) · JWT Required · Tenant Validation · Permission Validation · Access Token Available (handled transparently by the shared, Redis-cached `gdsHttpClient.getAmadeusToken()` from EXT-002) · **Price Expiry Validation** — a real check against `flightOffer.searchedAt` (added to `FlightOfferMapper`'s DTO specifically to make this check honest — without a real timestamp, "expiry validation" would have nothing real to validate against), rejecting an offer older than `AMADEUS_PRICING_MAX_OFFER_AGE_SECONDS` as `INVALID_FLIGHT_OFFER`.

---

## 6. Business Rules (as implemented)

**Never cached.** `AmadeusFlightPricingService` makes zero calls to `CacheManager` or the shared `searchCache` — every request is either a fresh live Amadeus pricing call or a fresh dynamic-sandbox simulation, matching "Always validate live pricing. Never trust cached prices." literally. Currency returned by the provider is preserved verbatim in the response (`pricing.currency`, never the client's request currency). Expired offers return a structured `409 INVALID_FLIGHT_OFFER`.

---

## 7. Successful Response (unchanged price)

```json
{ "success": true, "message": "...", "data": { "priceVerified": true, "priceChanged": false, "currency": "PKR", "baseFare": ..., "taxes": ..., "totalPrice": ..., "fareType": "Published", "lastTicketingDate": "...", "numberOfBookableSeats": 5 }, "requestId": "..." }
```

## 8. Price Change Response (still bookable, HTTP 200)

Adds `previousPrice`, `newPrice`, and `message: "Price updated by airline."` when the provider's live total differs from the client-supplied `totalPrice`.

## 9. Error Response (HTTP 409/429/503/504)

```json
{ "success": false, "message": "Selected fare is no longer available.", "data": { "code": "FLIGHT_NOT_AVAILABLE" }, "requestId": "..." }
```

**Note on error shape**: the doc's own raw example puts `code` at the top level; this codebase's established `sendError(res, statusCode, message, requestId, data)` envelope always nests extra structured data under `data`, so `code` lives at `response.data.code` here — consistent with every other endpoint in this ERP, not a special case for this one.

**Note on error code mapping**: §12's "price changed" example and §13's "PRICE_CHANGED → 409" example aren't fully reconcilable literally (one is a 200 success, the other a 409 failure using the same code name). This implementation reserves `priceChanged: true` for the 200 case (§7/§8) and uses `FLIGHT_NOT_AVAILABLE` (not `PRICE_CHANGED`) for the 409 case where Amadeus's pricing call fails outright because the offer is genuinely gone — the more semantically precise of the two doc-listed codes for that situation.

---

## 10. Possible Errors (all implemented)

`INVALID_FLIGHT_OFFER` (400/409) · `FLIGHT_NOT_AVAILABLE` (409) · `RATE_LIMIT_EXCEEDED` (429) · `PROVIDER_TIMEOUT` (504) · `PROVIDER_UNAVAILABLE` (503, both "circuit breaker open" and "no live credentials + provider call failed") · `INVALID_PROVIDER_RESPONSE` (502, Amadeus responded but with no priced offer in the payload)

---

## 11. Performance (as implemented)

No Cache ✓ · Always Live ✓ · **Timeout 30 Seconds** — `AMADEUS_PRICING_TIMEOUT_MS`, a distinct policy from search's `GDS_REQUEST_TIMEOUT_MS`, passed as a per-call override into `gdsHttpClient.requestAmadeus()` (which was extended with an `options` parameter for exactly this, without changing behavior for any existing caller) · **Retry Once** — `AMADEUS_PRICING_MAX_RETRIES` (default 1), independent of the general `GDS_AMADEUS_HTTP_MAX_RETRIES` search retry budget · **Circuit Breaker Enabled** — shares the exact same breaker instance EXT-002/API-006B already use against Amadeus, since a failure discovered by one path should count against the other.

---

## 12. Domain Events

- `FlightPriceVerified` (unchanged price)
- `FlightPriceChanged`
- `FlightPricingFailed`

---

## 13. Logging (as implemented)

Every call — success or failure — writes a real `AuditLogModel` entry: Tenant, User, Provider, Duration, Request ID, Price Before, Price After, Currency, Response Code. No access token ever appears in any log line (the shared `gdsHttpClient` already never logs one, per EXT-002).

---

## 14. AI Coding Rules Summary

✓ Always Verify Live Fare ✓ Never Cache Prices ✓ Preserve Provider Currency ✓ Wrap Provider Response In DTO ✓ Log Price Changes ✓ Do Not Expose Raw Provider Payload ✓ Support Future Providers (the `flightOffer.provider === "Amadeus"` check is the only provider-specific line in the controller/service; a second provider's pricing adapter would plug in the same way `SabreAdapter` already does for search)

---

## 15. Completion Status

- **Status**: Production Ready
- **Document ID**: `EXT-003`
- **Provider**: Amadeus
- **Next Document**: `EXT-004 — Amadeus Flight Booking API`
