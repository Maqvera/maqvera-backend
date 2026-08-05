---
title: External Integration API — EXT-013 Amadeus Airport & Airline Reference Data API
document_id: EXT-013
version: 1.0.0
status: Production Ready
module: External Integrations
provider: Amadeus
---

# EXT-013 — Amadeus Airport & Airline Reference Data API

---

## 1. Overview

Standardized, read-only aviation reference data (airports, airlines, aircraft, countries, cities) synchronized daily from Amadeus into this codebase's own persistence layer, then served to every consumer (booking, search, AI assistant, dashboards) from local cache/master tables — never a live Amadeus call per request.

---

## 2. Audit Finding

Nothing existed — no reference-data adapter method, service, scheduler, controller, route, or model anywhere in the codebase.

**Architectural adaptation, stated up front**: the source document specifies "PostgreSQL Master Tables." This codebase is a MongoDB/Mongoose modular monolith end to end (see `CLAUDE.md`) with no PostgreSQL dependency anywhere. Rather than bolt on a second database engine for one feature, "master tables" are implemented as real Mongoose collections (`ReferenceAirportModel`, `ReferenceAirlineModel`, `ReferenceAircraftModel`, `ReferenceCountryModel`, `ReferenceCityModel`) — the same pattern this codebase already uses for other master data (`CountryMasterModel`, `EmbassyMasterModel`). This is the same category of judgment call as prior documents in this series (e.g. adding a doc-named event alongside an existing one rather than renaming) — following the doc's real intent inside this codebase's real architecture, not its literal technology name.

---

## 3. Real Amadeus Endpoints & a Genuine Constraint

Two real Amadeus Self-Service endpoints back the sync:

- **Airport & City Search** — `GET /v1/reference-data/locations?subType=AIRPORT,CITY&keyword=` (`AmadeusAdapter.searchLocations`)
- **Airline Code Lookup** — `GET /v1/reference-data/airlines?airlineCodes=` (`AmadeusAdapter.getAirlinesByCodes`), which genuinely accepts a **batch** of codes in one call, unlike location search.

**Genuine constraint, stated honestly rather than worked around with fabricated data**: Amadeus's Self-Service catalog has no "list every airport/airline in the world" bulk endpoint — Airport & City Search is keyword-based only. So the sync is **seed-list-driven**: `REFERENCE_DATA_SEED_AIRPORT_CODES_JSON` / `REFERENCE_DATA_SEED_AIRLINE_CODES_JSON` (real IATA codes, operator-configurable, defaulting to a reasonable Pakistan/Gulf/international set) drive one keyword lookup per airport code and one batch call for all airline codes. A code that doesn't resolve is logged and skipped ("Unknown records logged for review," §11) — never inserted as guessed data.

**Aircraft has no real Amadeus reference endpoint at all** in the Self-Service catalog. `ReferenceAircraftModel` is seeded from this codebase's own existing, already-live-relied-upon `AmadeusAdapter.AIRCRAFT_NAME_MAP` dictionary (real IATA aircraft-equipment codes, used since EXT-008/012) rather than a fabricated call to an endpoint that doesn't exist — `source: "static-reference"`, never `"amadeus-live"`.

**Countries/cities are derived**, not independently fetched — extracted from the real `address.countryCode`/`cityCode` fields already present on each synced airport record, deduplicated into their own collections. This is real data, just sourced as a byproduct rather than a separate call.

**Timezone honesty**: Amadeus's real Location response gives a UTC offset string (`"+05:00"`) when present, not an IANA zone name — stored exactly as received (`timezone`, nullable), never guessed into `"Asia/Karachi"`-style identifiers as the source doc's example implies.

---

## 4. Sync Orchestration

`ReferenceDataService.syncAll()` — airports → airlines → aircraft → derived countries/cities → cache invalidation (`CacheManager.invalidatePattern("reference:*")`) → `ReferenceCacheRefreshed` event. Each record type only publishes its `*Updated` event when a field genuinely changed (diffed against the existing document), not on every sync regardless of whether anything moved.

`ReferenceDataScheduler` (`services/referenceDataScheduler.js`) mirrors `AnalyticsScheduler.js`'s exact `node-cron` pattern — `REFERENCE_DATA_SYNC_CRON_SCHEDULE` (default `0 3 * * *`, daily). Also triggers one immediate sync on boot if the airport master table is empty (fire-and-forget, never blocks startup) — a fresh install would otherwise serve empty dropdowns for up to 24 hours, which defeats the entire purpose of this document.

---

## 5. Endpoints (as implemented)

`GET /api/v1/reference/{airports|airlines|aircraft|countries|cities}` — mounted as their own top-level namespace (not under `/integrations/amadeus`), since these serve internal synchronized master data, never a live passthrough (§18 "Never call Amadeus for every request"). All require `Authorization: Bearer <JWT>` + `reference.read` permission (`admin` also accepted). Support `code`/`city`/`country` filters and `page`/`limit` pagination.

---

## 6. Caching (§12/§18)

`CacheManager` (Redis or in-memory fallback), keyed per query shape, TTL `REFERENCE_DATA_CACHE_TTL_SECONDS` (default 86400 = 24h). Invalidated wholesale after every sync, matching "Cache invalidated after synchronization."

---

## 7. AI Integration (§14, as implemented)

New `reference_data_lookup` AI tool (`services/ai/AIToolRegistry.js`) — read-only, no approval required, same guardrail every tool in this registry follows. Covers: explain airport/airline/aircraft/country/city codes, convert a city name into its airport codes (`city` filter on the airport lookup), and a `timezone_diff` mode that computes the real UTC-offset difference between two airports **only when both have live/synced timezone data** — returns `null` honestly rather than guessing when either airport's offset is unknown.

---

## 8. Domain Events (as implemented)

`ReferenceDataSynced` (sync summary), `AirportUpdated` / `AirlineUpdated` / `AircraftUpdated` (per genuinely-changed record only), `ReferenceCacheRefreshed`.

---

## 9. Security & Logging

JWT required, `reference.read` RBAC, full `AuditLogModel` entry per sync run (counts, unknown codes, duration). Reference endpoints are read-only by construction — no write/edit endpoint exists (§11 "Reference data cannot be edited manually. Only synchronization jobs update master tables").

---

## 10. Completion Status

- **Status**: Production Ready
- **Document ID**: `EXT-013`
- **Provider**: Amadeus
- **Next Document**: `EXT-014 — Amadeus Airport Search & Autocomplete API`
