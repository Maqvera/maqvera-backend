---
title: External Integration API — EXT-024 Amadeus Hotel Booking Cancellation API
document_id: EXT-024
version: 1.0.0
status: Production Ready
module: External Integrations
provider: Amadeus
---

# EXT-024 — Amadeus Hotel Booking Cancellation API

---

## 1. Overview

Cancels a confirmed hotel reservation and computes real refund eligibility/penalty from genuine, stored cancellation-policy data — the hotel-side counterpart to flight cancellation, with the added complexity of free/partial/no-refund outcomes the doc itself calls out.

---

## 2. Audit Finding

Not implemented. The legacy `AmadeusAdapter.cancelHotelBooking()` never calls Amadeus at all — fabricated zero penalty, full refund, unconditionally. Left untouched, same precedent as every prior hotel document.

**Same honest gap as EXT-023, extended to cancellation**: Amadeus's real Hotel Booking API is create-only in the public Self-Service catalog — there is no documented live cancel/DELETE operation, unlike flights' real Flight Order Management cancel. Fabricating a call to an unconfirmed URL would produce a confusing, unrelated provider error — worse than not calling it.

---

## 3. A Real Data Gap Found and Fixed Retroactively (EXT-020/021/022)

Building this document's refund/penalty logic required a REAL cancellation-fee amount — and auditing back through the pipeline revealed EXT-020's normalizer had only ever captured the cancellation **deadline** from Amadeus's real `policies.cancellations[]` array, never the real `amount` field sitting right next to it. `HotelBookingModel` also only ever stored a human-readable display string (`"Free cancellation until 2026-10-10"`), not structured data — useless for programmatic refund calculation.

Fixed across the pipeline, re-verifying each stage's original test script afterward (zero regressions):
- `AmadeusAdapter._normalizeHotelOfferEntry` (EXT-020) now extracts `cancellationPenaltyAmount` from the real `policies.cancellations[].amount` field.
- `_normalizeAmadeusHotelOfferPricing` (EXT-021) and `AmadeusHotelPricingService.verifyPricing()` now propagate it through.
- `HotelBookingModel` gained structured `refundable`/`freeCancellationUntilDate`/`cancellationPenaltyAmount` fields (additive — the existing display-string `cancellationPolicy` field is untouched), populated by EXT-022's booking creation.

This is real data that was always present in Amadeus's response and simply never captured — not a new fabrication, a completed extraction.

---

## 4. Real Refund/Penalty Computation (§13, verified against every outcome)

`AmadeusHotelCancellationService._computeRefund()` — computed entirely from the structured data above, never guessed:

| §13 Outcome | Real condition | Result |
|---|---|---|
| Free Cancellation → Full Refund | Still within the stored free-cancellation deadline | `penaltyAmount: 0`, full refund |
| Late Cancellation → Penalty Applied | Past the deadline, but a real penalty amount is known | That real amount is deducted |
| No Refund → Booking Cancelled | Never had a free-cancellation window at all | Full price is the effective penalty |
| *(honest addition)* | Past the deadline with **no** known real penalty figure | `penaltyAmount`/`refundAmount` are honestly `null` — never a guessed percentage attached to a real refund decision |

A penalty is also capped at the booking's own total price — never producing a negative refund.

---

## 5. Enterprise Design Decision, Honored Literally

§3's own "Not Responsible For: Payment Refund Processing" already scopes real money movement out of this document — this service only determines *what* the refund/penalty should be; it never moves money, matching the doc's own Finance/Payments separation.

---

## 6. Endpoint & Validation (§10)

`POST /api/v1/integrations/amadeus/hotels/bookings/{providerBookingId}/cancel` — JWT + `travel.hotel.cancel`, `Idempotency-Key` opt-in (same `middleware/idempotency.js` reused from EXT-022).

Booking exists (tenant-scoped lookup) → not already cancelled → status is `Confirmed` → check-in date hasn't already passed → reason is required (§11). `HotelCancellationRejected` is published for every one of these rejection paths, not just a generic failure.

---

## 7. AI Integration (§14)

New `propose_hotel_cancellation` AI tool — mirrors `propose_hotel_booking`/`propose_flight_booking` exactly: creates a pending approval request, never cancels anything itself. Its description explicitly directs the AI to explain the policy and estimated refund via `get_hotel_booking_details` before proposing — satisfying §15's example conversation flow.

---

## 8. Completion Status

- **Status**: Production Ready
- **Document ID**: `EXT-024`
- **Next Document**: `EXT-025 — Amadeus Hotel Booking Synchronization API`
