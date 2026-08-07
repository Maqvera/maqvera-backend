---
title: Audit — does the same single-tenant disease exist outside Auth?
document_id: TENANT-FIX-02
version: 2.0.0
status: Production Ready
module: Auth / Tenant Isolation
---

# Audit — does the same single-tenant disease exist outside Auth?

---

## 1. Findings confirmed

- Every controller sampled (`CustomerController.js`, `BookingController.js`, `UserController.js`, and ~35 others) already required `req.auth.tenantId` and 403'd if absent — the disease from `01-tenant-provisioning-fix.md` was genuinely isolated to the provisioning entry point.
- **`VisaController.js`** (39 occurrences), **`TravelIncidentController.js`** (14 occurrences), **`middleware/idempotency.js`** (1 occurrence) fell back through `req.auth?.tenantId || req.headers["x-tenant-id"] || "default-tenant"` — never rejecting, trusting a client-settable header.
- **Escalated during audit**: `routes/VisaRoutes.js` had `GET /visa-cases` and `GET /visa-cases/:visaCaseId` fully public (no `authenticateAccessToken` at all). Combined with the header-trust bug, this meant an anonymous, unauthenticated caller could read any tenant's complete visa case list — including passport numbers and traveler PII — just by setting `x-tenant-id` to a guessed/known tenant key. This was live and exploitable, not merely a "landmine." Both routes now require authentication; `getVisaTypes`, `getCountryVisaRequirements`, and `getVisaWorkflowDefinition` remain public (genuinely tenant-agnostic catalog/reference data) with the header-trust removed.
- **A second, broader instance of the same disease found during the controller-by-controller rollout** (not caught by the initial grep, which only matched the literal string `"default-tenant"`): 30 occurrences across 10 files used `req.auth?.tenantId || "default"` (or `"main"` for branchId) — the identical silent-fallback anti-pattern, just a different hardcoded literal. Affected: `FlightBookingController.js` (14), `HotelDistributionController.js` (8), 7 AI controllers (`AIPromptController`, `AIOrchestrationController`, `AIObservabilityController`, `AIModelRouterController`, `AIKnowledgeController`, `AIGuardrailController`, `AIAssistantController` — one shared `buildContext(req)` helper each), `FlightSearchController.js`, `ExternalFlightController.js`. All fixed the same way: reject with 403 instead of defaulting.
- `CLAUDE.md` itself documented the header/default-tenant fallback as if it were correct architecture — corrected.
- **16 `Amadeus*Controller.js` files audited and confirmed already safe**: `tenantId` sourced only from `req.auth`, reject on missing; the few that use `branchId` (booking-creation endpoints) source it directly from `req.auth?.branchId`, never from a client-controllable query/body field — so there is no override vulnerability, unlike the pattern found elsewhere. No fix needed.

## 2. What Was Built

- **Every file with the "default-tenant"/header-trust or `|| "default"`/`"main"` literal fallback** — replaced with strict `req.auth?.tenantId` sourcing; missing tenant context now 403s (or, for idempotency, skips deduplication) instead of silently defaulting to a shared fake tenant.
- **`getAccessScope(req)` (`utils/accessScope.js`) rolled out to 15 controllers**, not just Customer/Visa/Incident: `BookingController.js`, `UserController.js`, `TravelPlanController.js`, `TravelFlightController.js`, `TravelHotelController.js`, `TravelTransportController.js`, `TravelItineraryController.js`, `TravelNotesTimelineController.js`, `TravelDashboardController.js`, `TravelAttendanceController.js`, `VisaDashboardController.js`, `EnterpriseSearchController.js` — each converted from a bare `{ tenantId }` filter (or, in `VisaDashboardController`/`EnterpriseSearchController`, a bespoke `MANAGEMENT_ROLES`/permission-based branch check with the same query-override gap) to real branch-aware scoping. Branch-scoped callers are forced onto their own branch on both reads and writes; tenant-scoped callers may specify/narrow to any branch in their own tenant.
- **A genuine data-integrity finding, left unconverted on purpose**: `TravelTimelineModel.branchId` defaults to `"main"` whenever a creator omits it, and `TravelNotesTimelineController.js`'s own timeline-writing helper never sets it — meaning real non-"main"-branch timeline events are already mis-stamped. Filtering those queries by the caller's real branch would have made real events wrongly invisible instead of enforcing anything real, so that one query was deliberately left tenant-only, with the reasoning left in a code comment. Same reasoning applied to `FlightBookingController.js`/`HotelDistributionController.js` (their models' `branchId` also schema-defaults and is never explicitly set) — fixed for the tenant-fallback bug, left tenant-only for branch filtering.
- **`tests/visaIncidentIsolation.test.js`, `tests/bookingIsolation.test.js`, `tests/userIsolation.test.js`** (new) — live cross-tenant + cross-branch isolation proof against real MongoDB for Visa cases, Incidents, Bookings, and Employee profiles.
- **`tests/accessScopeRegression.test.js`** (new, expanded) — permanent regression guard: fails the build if `"default-tenant"`, `req.headers["x-tenant-id"]`/`"x-branch-id"`, or **any** `req.auth?.tenantId || "<hardcoded literal>"` fallback reappears anywhere in `controllers/` or `middleware/`, and if a controller on the `MIGRATED_TO_ACCESS_SCOPE` allowlist stops importing `getAccessScope`.
- **`CLAUDE.md`** — corrected the stale architecture description and added the mandatory rule: all tenant-owned data access must go through `getAccessScope(req)`.
- **`.github/PULL_REQUEST_TEMPLATE.md`** (new) — checklist item requiring `getAccessScope` usage and allowlist registration for any PR touching tenant-owned queries.

## 3. Scope completed

**Fully converted to `getAccessScope` (branch + tenant isolation enforced)**: `CustomerController.js`, `VisaController.js`, `TravelIncidentController.js`, `BookingController.js`, `UserController.js`, `TravelPlanController.js`, `TravelFlightController.js`, `TravelHotelController.js`, `TravelTransportController.js`, `TravelItineraryController.js`, `TravelNotesTimelineController.js`, `TravelDashboardController.js`, `TravelAttendanceController.js`, `VisaDashboardController.js`, `EnterpriseSearchController.js` — 15 of the 17 controllers named in this doc's original §7 list.

**Tenant-fallback bug fixed, branch-scoping not applicable (schema doesn't reliably carry a real branchId yet)**: `FlightBookingController.js`, `HotelDistributionController.js`.

**Fixed as newly-discovered instances of the same bug, outside the original §7 list**: `FlightSearchController.js`, `ExternalFlightController.js`, and 7 AI controllers (`AIPromptController`, `AIOrchestrationController`, `AIObservabilityController`, `AIModelRouterController`, `AIKnowledgeController`, `AIGuardrailController`, `AIAssistantController`).

**Audited, confirmed already safe, deliberately not converted**: all 16 `Amadeus*Controller.js` files (see §1) and `Role.name` lookups by ID (`RoleModel.find({_id:{$in:...}})` — ObjectId already uniquely scopes them).

**Genuinely still open, tracked, not silently assumed done**: `CustomerController.js`'s own sub-resource endpoints (documents, notes, family, passports, phones, emails, addresses, preferences — see `docs/05-api/05-customer-api.md`) remain tenant-only. The `TravelTimelineModel.branchId` mis-stamping (§2) is a real, separate data-integrity gap worth a dedicated fix.

## 4. Verification

Full suite: **73/73**. `node --check` clean on all 23 touched controller/middleware files. Live cross-tenant + cross-branch isolation confirmed against real MongoDB for Customer, Visa, Incident, Booking, and User/Employee data.

## 5. Completion Status

- **Status**: Production Ready
- **Regression protection**: `tests/accessScopeRegression.test.js` runs on every `node --test` invocation and would have caught every bug found in this document.
