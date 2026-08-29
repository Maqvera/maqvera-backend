# One-Click Automation Engine API

PRD "CRM Feature Map by Phase" Phase 3 module 22. Route lives in `routes/BookingRoutes.js` (mounted at `/api/v1/bookings`), requires `authenticateAccessToken` and the `booking.automation.run` permission (or `admin`) — deliberately separate from `bookings.update`, since one call can create a visa case, generate an invoice, and send a WhatsApp message.

**Scope note (read before wiring a frontend to this):** the PDF's full six-step vision (hotel allocation → flight booking → visa case → invoice → WhatsApp → payment reminders) is **not** what this endpoint does. Three of those steps aren't safely automatable in this codebase today:

- **Hotel room allocation** — a package-originated booking's hotel component is only ever a `BookingServiceModel` line; real room allocation (`TravelHotelController.AllocateRooms`) needs a `TravelPlanModel` + `TravelHotelAssignmentModel` that don't exist yet for it. Bridging that means inventing a mapping policy from a generic service line to a room assignment — a real product decision, not composition, and out of scope here.
- **Flight booking** — `AmadeusFlightBookingController.CreateAmadeusFlightBooking` requires a live Amadeus offer object from a prior human search/selection. There is no safe way to auto-select a real flight (real money, real PNR) on a customer's behalf.
- **Payment reminder scheduling** — no due-date field exists anywhere on `PaymentModel`/`BookingHeaderModel` to schedule a reminder against; this needs new schema and a new scheduler, not orchestration.

What this endpoint **does** automate — three steps that are each fully self-contained, already-built, and genuinely independent of one another (none needs to be undone if another fails, so this needed no compensation/rollback engine):

## `POST /api/v1/bookings/{bookingId}/one-click-complete`

Body (all optional):
```json
{
  "visa": { "countryId": "...", "destinationCountry": "...", "visaTypeId": "...", "visaType": "...", "travelPurpose": "Tourism", "priority": "normal" },
  "invoice": { "dueDate": "2027-01-01" },
  "whatsapp": { "templateId": "booking_confirmation" }
}
```

- **`create_visa_case`** — opt-in only, via the `visa` key. Destination/visa-type are never guessed from the booking (the booking's own service lines don't carry that data forward from the package that created them) — omit `visa` entirely and this step reports `skipped` with an honest reason. When supplied, calls the real `VisaService.createVisaCase` against `booking.customerId`; an existing active case for the same traveler/destination/type is reported `skipped`, not a duplicate.
- **`generate_invoice`** — calls the exact same `BookingController.GenerateBookingInvoice` a staff member would call by hand (same validation, same item-mapping from active `BookingServiceModel` lines). Skips (never duplicates) if a non-cancelled invoice already exists for this booking.
- **`send_whatsapp_confirmation`** — composed from `WhatsAppPlatformService.sendWhatsApp`. Skips gracefully (never fails the whole run) when: the customer has no phone on file, no `Active` WhatsApp template named `templateId` (default `"booking_confirmation"`) exists for the tenant, or a prior run already sent one for this booking.

Response: the persisted `BookingAutomationRunModel` row — `{status: "completed"|"partial", steps: [{name, status: "success"|"skipped"|"failed", detail, error, durationMs}], triggeredBy, createdAt}`. `status` is `"partial"` whenever any step `failed` — the response always reports every step's real outcome rather than aborting after the first failure, since the three steps are independent.

## `GET /api/v1/bookings/{bookingId}/one-click-complete/runs`

Lists every past automation run for a booking (newest first) — `booking.automation.run`, `bookings.read`/`booking.read`, or `admin`.
