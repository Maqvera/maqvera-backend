# Package Pricing Engine API

The Package Pricing Engine turns supplier cost data (hotel/transport/flight/visa/service rates) into a customer-facing, room-wise price matrix for a multi-segment travel package (Umrah/Hajj and any other destination — see `Global-Package-Pricing-Engine-PRD-v2.1-Refactored.md`). It is a from-zero build: `models/PackageModel.js`, `models/HotelRateModel.js`, `models/TransportVehicleModel.js`, `models/TransportRateModel.js`, `models/FlightRateModel.js`, `models/VisaRateModel.js`, `models/ServiceRateModel.js`, `models/MarkupRuleModel.js`, `models/RoomTypeModel.js`, and `models/RateSnapshotModel.js`, served by `services/PackagePricingService.js` and `controllers/PackagePricingController.js`.

**Not the Finance Pricing module.** `PricingController.js`/`PricingService.js`/`PricingRuleModel.js` (`/api/v1/pricing-rules`, `/api/v1/pricing/calculate`, docs/05-api/07-finance-api.md Part 21) is an unrelated invoice discount engine (Customer/Contract/Volume/Promotion/Loyalty rules against a productCode). This module never reads or writes those collections.

All routes live under `routes/PackageRoutes.js`, mounted at `/api/v1/packages`, and require `authenticateAccessToken` — package cost/pricing data is tenant-owned business data, never public. Tenant scope is always `getAccessScope(req)`; there is no branch dimension. Permission keys: `package.pricing.read`, `package.pricing.manage`, `package.pricing.calculate`, `package.pricing.finalize`, `package.pricing.cost.read`, `package.pricing.quotation.manage` (or `admin`).

**Cost/profit visibility (PRD §50/§117).** `package.pricing.cost.read` gates `hotelCostPerPerson`, `transportCostPerPerson`, `flightCostPerPerson`, `visaCostPerPerson`, `servicesCostPerPerson`, `subtotalPerPerson`, `markupAmount`, and `commissionPerPerson` on every `roomWisePriceMatrix` row returned by `GET /packages/{id}`, `GET /packages`, and `POST /packages/{id}/calculate` — a caller without it only ever sees `roomTypeName`, `occupancy`, `discountAmount`, `finalPricePerPerson`, and `roomTotal`.

## Suppliers & commission

- `/suppliers` — `GET`/`POST`/`PATCH /suppliers/{id}`. `name`, `category` (`Hotel`/`Transport`/`Flight`/`Visa`/`Service`/`General`), `contactName`, `phone`, `email`, `currency`, `notes`. Every rate model (`hotel-rates`, `transport-rates`, `flight-rates`, `visa-rates`, `service-rates`) carries an optional `supplierId` ref to this master alongside its own free-text `supplier` display string, plus `contractRef`, `receivedDate`, `notes`, `documentUrl` (PRD §74 "Where did this rate come from?").
- `/commission-rules` — `GET`/`POST`. `scope` (`Agent`/`Destination`/`Hotel`/`Global`), `type` (`Fixed`/`Percentage`), `value`, plus the matching `agentUserId`/`destinationCountry`/`hotelCatalogId`. Computed per room-wise matrix row as `commissionPerPerson` — informational only, never affects `finalPricePerPerson`, and gated behind `package.pricing.cost.read` like every other cost field.

## Master & rate data

Each of the following supports `GET` (list, filterable by the fields shown) and `POST` (create) under `/api/v1/packages/<path>`; every one (plus `/suppliers`) also supports `PATCH /<path>/{id}` — a partial update that diffs the changed fields and writes an `AuditLogModel` entry (`{field, oldValue, newValue, reason}`) per PRD §75, only when at least one field actually changed. Pass `{"reason": "..."}` in the PATCH body to record why.

- `/room-types` — tenant-configurable room type master (`name`, `defaultOccupancy`, `sortOrder`, `active`). Replaces any hardcoded Single/Double/.../Quint enum.
- `/transport-vehicles` — tenant-configurable vehicle master (`name`, `minCapacity`, `maxCapacity`, `luggageCapacity`, `category`).
- `/hotel-rates` — `hotelCatalogId` (ref `HotelCatalogModel`), `roomTypeId`, `currency`, `pricePerNight`, `occupancy`, `rateBasis` (`ExactDate`/`DateRange`/`Season`/`Weekend`/`Weekday`/`Standard`) plus the matching `date` or `validFrom`/`validTo`/`daysOfWeek`, `status`, `source`. Filters: `hotelCatalogId`, `roomTypeId`, `status`.
- `/transport-rates` — `origin`, `destination`, `vehicleId`, `currency`, `rate`, `direction`, validity window, `status`. Filters: `origin`, `destination`, `status`.
- `/flight-rates` — `route`, `airline`, `cabin`, `currency`, `costPerPerson`, `direction`, validity window, `status`. Filter: `route`, `status`.
- `/visa-rates` — `country`, `visaType`, `nationality`, `currency`, `adultCost`/`childCost`/`infantCost`, `processingTime`, validity window, `status`. Filter: `country`, `status`.
- `/service-rates` — `name`, `chargeBasis` (`PerPerson`/`PerRoom`/`PerNight`/`PerVehicle`/`PerGroup`/`PerBooking`/`Percentage`), `currency`, `amount`, validity window, `status`.
- `/markup-rules` — `name`, `scope` (`Hotel`/`Transport`/`Flight`/`Visa`/`Services`/`EntirePackage`), `type` (`Fixed`/`Percentage`), `value`, `priceListType` (`B2C`/`B2B`/`Corporate`/`VIP`).

Every rate record's `status` (`Draft`/`Verified`/`Active`/`OnRequest`/`StopSale`/`Expired`/`Archived`) and `currency` are required; only `Active` rates are ever used by the calculator — a missing rate is a validation issue, never a silent zero.

## Packages

- `POST /api/v1/packages` — creates a `Draft` package: `name`, `customerId` (ref `CustomerModel`), `agentUserId` (drives `CommissionRuleModel`'s `Agent` scope), `travelStartDate`, `travelEndDate`, `travelers` (`adults`/`children`/`infants`), `segments[]` (`city`, `hotelCatalogId`, `checkIn`, `checkOut`, `rooms`, `mealPlan`), `transportLegs[]`, `flightSelections[]`, `visaSelections[]`, `serviceSelections[]`, `vehicleSelectionRule`, `priceListType`, `sellingCurrency`, `markupRuleIds[]`, `commissionRuleIds[]`, `roundingRule`, `discount` (`{type, value, scope, reason}` — PRD §91). A segment is just "a hotel stay in a city" — Umrah's Makkah + Madinah is two segments of this one mechanism, never a dedicated field.
- `GET /api/v1/packages` (filters: `status`, `customerId`) / `GET /api/v1/packages/{packageId}` — list/read.
- `PATCH /api/v1/packages/{packageId}` — edits any of the fields above, but **only** while the package is `Draft` and unlocked; a `Calculated`/finalized package must go through calculate/finalize's own versioning instead.
- `POST /api/v1/packages/{packageId}/link-booking` — `{"bookingId": "..."}`, records `linkedBookingId` after verifying the booking exists in the same tenant (PRD §87 CRM Integration). Does not create or mutate the booking itself.
- `POST /api/v1/packages/{packageId}/convert-to-booking` — `{roomTypeId, rooms?, bookingId?, bookingType?}`. The real Package → Booking seam: turns one calculated `roomWisePriceMatrix` row into real `BookingServiceModel` line items (one per non-zero cost component — hotel/transport/flight/visa/services — `costPrice` from the row's own pre-markup cost, `sellingPrice` allocated proportionally against the row's markup+discount delta), then calls the Booking domain's own `recalculateBookingFinancials` (`controllers/BookingController.js`) — never a second, parallel total. Creates a new Draft booking (requires `package.customerId`) when `bookingId` is omitted, or appends the line items to an existing booking otherwise. Sets `package.status = "Booked"` and `linkedBookingId` on success.
- `POST /api/v1/packages/{packageId}/calculate` — resolves every hotel/transport/flight/visa/service rate for the package's dates, converts each to `sellingCurrency` via `CurrencyService.getRate`, applies markup, discount, and rounding (in that order — PRD §48), and writes `roomWisePriceMatrix` (one row per room type every segment's hotel has an active rate for) plus `validationIssues` and `priceValidUntil` (now + `PACKAGE_PRICE_VALIDITY_HOURS`, default 72h). Always succeeds and returns `{ ready, validationIssues, roomWisePriceMatrix, ... }` — a business-rule gap (no rate, no exchange rate, insufficient transport capacity) is reported as an issue, never a thrown error or a wrong number. Persists a `RateSnapshotModel` row (`snapshotType: "Calculate"`).
  - Pass `{ "recalculate": true }` to recalculate a locked/finalized package — this **never** overwrites it in place (PRD §51 Package Versioning): a new `Package` document is created (`version` + 1, `previousVersionId`/`rootPackageId` set), the old one gets `supersededBy` set and is left untouched, and the response includes `newVersionOf` pointing at the superseded package's id.
- `POST /api/v1/packages/{packageId}/finalize` — only from status `Calculated` with zero open `validationIssues`; locks the package (`locked: true`), sets `status: "Quoted"`, and persists a second `RateSnapshotModel` row (`snapshotType: "Finalize"`) so the price stays reproducible even if the source rates change later.

## Quotations

- `POST /api/v1/packages/{packageId}/quotations` — `{roomTypeId, paymentTerms?, validUntil?, termsAndConditions?}`. Picks one row out of the package's last-calculated `roomWisePriceMatrix`, mints a real document number via `NumberGeneratorService` (`resourceType: "Quotation"` — a `NumberingSchemeModel` must exist for it first, same requirement as every other document type in this codebase), and freezes it plus the tenant's branding/terms into an immutable `QuotationModel.snapshotData`. Deliberately never includes supplier cost, markup, or commission (PRD §117) — only customer-facing fields.
- `GET /api/v1/packages/{packageId}/quotations` / `GET /api/v1/packages/quotations/{quotationId}` — list/read.
- `POST /api/v1/packages/quotations/{quotationId}/pdf` — renders `templates/packages/quotation.html` via the existing `services/HtmlPdfRenderer.js` (Handlebars + headless Chromium) pipeline, stores it through `utils/documentPdfStorage.js`, and sets `pdfUrl`.
- `POST /api/v1/packages/quotations/{quotationId}/send` — `{channel?: "email"|"whatsapp"|"both", email?, phone?, message?}` (`channel` defaults to `email`). Dispatches the quotation to the customer through `services/EmailPlatformService.js` (PDF attached, generating it first via the `/pdf` step above if it hasn't been yet) and/or `services/WhatsAppPlatformService.js` (PDF link) — never owns its own send/provider logic. Falls back to the linked `CustomerModel`'s email/phone when `email`/`phone` aren't supplied; 400s if neither is available. Sets `status: "Sent"` on success. Requires `package.pricing.quotation.manage` (or `admin`), same as create/PDF.
- `POST /api/v1/packages/quotations/{quotationId}/convert-to-booking` — `{rooms?, bookingId?, bookingType?}`. A thin wrapper around `POST /packages/{packageId}/convert-to-booking` — pulls the `packageId`/`roomTypeId` the quotation already froze at generation time, so the caller never re-specifies which room-wise matrix row was quoted. Creates a new Draft booking (or appends to an existing one when `bookingId` is supplied), sets the quotation's `status: "Accepted"` and `convertedBookingId`, and 400s if the quotation was already converted. Requires `package.pricing.quotation.manage` (or `admin`).

## Dynamic pricing suggestion (PRD "CRM Feature Map by Phase" Phase 4 module 27)

- `GET /api/v1/packages/{packageId}/dynamic-pricing-suggestion` — advisory only, never mutates `PackageModel` or feeds back into `calculatePackage`. Returns `{ season: "Ramadan"|"Hajj"|null, seasonMultiplier, nearbyBookingCount, isHighDemand, demandMultiplier, combinedMultiplier, suggestedMatrix: [{ roomTypeId, roomTypeName, currentFinalPricePerPerson, suggestedFinalPricePerPerson }] }`. `season` comes from `utils/hijriCalendar.js`'s `getIslamicSeason` (real Umm al-Qura Hijri conversion, not a hand-maintained date table) against the package's own `travelStartDate`; `isHighDemand` is real booking-velocity — `BookingHeaderModel` rows (excluding `cancelled`/`draft`) whose `travelDate` falls within `PACKAGE_HIGH_DEMAND_WINDOW_DAYS` (default 3) of the same date. All multipliers are config-driven (`utils/packagePricingConfig.js`: `ramadanPriceMultiplier`, `hajjPriceMultiplier`, `highDemandBookingThreshold`, `highDemandPriceMultiplier`), never hardcoded. Requires `package.pricing.read` (or `admin`) — same permission as reading the package itself, since this is a read-only suggestion a human then decides whether to act on (e.g. via a markup rule or manual rate override).

## Room-wise price matrix

Each `roomWisePriceMatrix` row: `roomTypeId`, `roomTypeName`, `occupancy`, `hotelCostPerPerson`, `transportCostPerPerson`, `flightCostPerPerson`, `visaCostPerPerson`, `servicesCostPerPerson`, `subtotalPerPerson`, `markupAmount`, `finalPricePerPerson`, `roomTotal`. Only room types present in the intersection of every segment's own active hotel rates ever appear — a hotel offering only Double/Triple/Quad never shows Single or Quint.

## Flyer generation

- `POST /api/v1/packages/{packageId}/flyers` — `{template?, format?, dimensionPreset?, roomTypeIds?}`. Renders `templates/packages/flyer.html` — the package's own last-calculated `roomWisePriceMatrix` (only the room types actually present, PRD §57), tenant branding, and an itinerary table — through `services/HtmlPdfRenderer.js`'s existing Handlebars+headless-Chromium pipeline, extended with a new `renderHtmlToImageBuffer` sibling to `renderHtmlToPdfBuffer` for PNG/JPG output (`format: "PDF"` uses the original PDF path). `dimensionPreset` (`InstagramPost`/`InstagramStory`/`FacebookPost`/`WhatsAppImage`/`Square`/`Portrait`/`A4`/`A5`) sets the render viewport. Ships with one template (`Standard`) for MVP — more are additive template files, not a pipeline change. Stores the result via `utils/documentPdfStorage.js` and creates a `FlyerModel` row.
- `GET /api/v1/packages/{packageId}/flyers` — list previously generated flyers.

## WhatsApp package messaging

- `POST /api/v1/packages/{packageId}/whatsapp-message` — `{phone?, roomTypeIds?}`. Builds a PRD §66-shaped text message (destination, dates, hotel, per-room prices, includes checklist, CTA) from the package's calculated matrix and sends it through the **existing** Enterprise Communication Platform (`services/CommunicationPlatformService.js`, channel `"WhatsApp"`) and its real Twilio-backed `services/delivery/WhatsAppDeliveryAdapter.js` — the same infra `VisaCommunicationListener.js` already uses, not a new integration. `phone` falls back to the linked customer's phone on file. Requires `TWILIO_ACCOUNT_SID`/`TWILIO_AUTH_TOKEN`/`TWILIO_WHATSAPP_FROM` to be set in `.env` for an actual send to go out (see `.env.example`).

## Rate availability status (On Request / Stop Sale / Sold Out)

Rate resolution (hotel/transport/flight/visa/service alike) distinguishes a **genuinely missing** rate from one that **exists but isn't auto-confirmable**: if the best-matching rate's status is `OnRequest`/`StopSale`/`SoldOut`, `calculatePackage` pushes `RATE_ON_REQUEST`/`RATE_STOP_SALE`/`RATE_SOLD_OUT` (never silently priced as Active); a genuinely absent rate still surfaces the original `NO_HOTEL_RATE`/`INVALID_*_RATE` codes. `RATE_CHANGED_SINCE_LAST_CALCULATION` is pushed when a rate this run resolved differs from the value recorded in the package's own last `RateSnapshotModel` row — informational only, never blocks `ready` or finalize.

## Extra beds, room combinations, comparison

- `HotelRateModel` carries `extraBedRate`/`extraBedBasis`/`maxExtraBeds`; `PackageSegment.extraBeds` requests extra occupants for that segment. `EXTRA_BEDS_EXCEED_MAX`/`EXTRA_BEDS_NOT_AVAILABLE` issues surface instead of silently dropping the guest.
- `GET /api/v1/packages/{id}/room-combinations` — suggests room-count combinations (e.g. "4 Double, or 2 Quad, or 1 Quad + 2 Double") for the package's own traveler count against its calculated matrix's room types.
- `POST /api/v1/packages/compare` — `{packageIds: [...]}`, returns 2+ already-calculated packages' matrices side by side (never recalculates).

## Package templates

- `POST /api/v1/packages/{id}/save-as-template` — `{name}`, saves the package's segments (as day-offsets from its own start, so a clone can land on new dates) plus its transport/flight/visa/service selections and pricing config.
- `GET /api/v1/package-templates` / `POST /api/v1/package-templates/{id}/clone` — `{travelStartDate, name?, customerId?, agentUserId?, travelers?}` creates a new Draft package from the template.

## Bulk rate management & export

For each rate type (`hotel-rates`/`transport-rates`/`flight-rates`/`visa-rates`/`service-rates`):
- `POST /{rate-type}/bulk` — `{items: [...]}`, all-or-nothing (a real Mongo transaction where the deployment supports one; best-effort sequential on a standalone Mongo).
- `PATCH /{rate-type}/bulk-status` — `{ids: [...], status, reason?}`, one audit-log entry per batch.
- `POST /{rate-type}/{id}/clone` — duplicates one rate row with any overridden fields in the body (new validity window, typically).
- `GET /{rate-type}/export?format=csv` — plain CSV dump (XLSX intentionally not added yet — this codebase already depends on `exceljs` elsewhere, but the PRD's own guidance was to confirm the format is actually needed before building it).

## Analytics

`GET /api/v1/packages/analytics/summary` (requires `package.pricing.cost.read`) — packages created/sold (`status: "Booked"` = sold), average package value/profit/margin, most popular destination/hotel/room type, most profitable and lowest-margin package. Computed in application code over a tenant-scoped `.find().lean()`, not a Mongo aggregation pipeline — simpler to keep correct for a first-pass dashboard.

## Rate expiry & scheduler

`services/packageRateExpiryScheduler.js` (wired into `server.js` alongside the other `*ExpiryScheduler`s) runs on `PACKAGE_RATE_EXPIRY_CRON_SCHEDULE` (default daily at 03:00): flips any `Active` hotel/transport/flight/visa/service rate past its own `validTo`/`date` to `Expired` (never deleted), and publishes `PackageRateExpiringSoon` for anything Active within `PACKAGE_RATE_EXPIRY_WARNING_DAYS` (default 7) of expiring.

## Out of scope for this pass

Excel/CSV/PDF/OCR import, social-platform (Instagram/Facebook/TikTok/LinkedIn/X) publishing, supplier API integrations, live FX feeds, and AI package building are Phase 2-4 per the PRD and are not implemented here — social publishing specifically needs real OAuth app credentials per platform before any code can be written (see this module's earlier scoping conversation).
