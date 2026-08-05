---
title: External Integration API — EXT-014 Airport Search & Autocomplete API
document_id: EXT-014
version: 1.0.0
status: Production Ready
module: External Integrations
provider: Amadeus (indirect — reads EXT-013's synchronized local data only)
---

# EXT-014 — Airport Search & Autocomplete API

---

## 1. Overview

Ranked, typo-tolerant airport/city autocomplete. Reads **only** EXT-013's locally synchronized reference tables — this endpoint never calls Amadeus itself, matching the doc's own "Enterprise Recommendation" not to hit the provider per keystroke.

---

## 2. Audit Finding

Not implemented. EXT-013's `getAirports()` only did exact-code/anchored-case-insensitive filtering — no ranking, no fuzzy/phonetic matching, no dedicated `/search` endpoint, no distinct 1-hour cache tier. Built on top of it.

**Architectural adaptation, same category as EXT-013's**: §15 asks for "GIN Full Text Index / Trigram Index" — PostgreSQL-specific features this MongoDB-only codebase has no equivalent for. A real Mongo text index is added to `ReferenceAirportModel` as a cheap candidate pre-filter at scale, but the actual ranking (§13's 7 tiers) is computed in `ReferenceDataService` using genuine, standard algorithms — prefix/substring matching, **Levenshtein edit distance** for fuzzy matching, and **Soundex** for phonetic matching — since Mongo's `$text` has no prefix or fuzzy-distance support of its own and there's no direct equivalent to `pg_trgm` trigram similarity.

---

## 3. Endpoint

`GET /api/v1/reference/airports/search?q=Kar` — JWT + `reference.read` (or `admin`).

### Query Parameters
`q` (required, 2–100 chars, sanitized against a Unicode-letter/digit/space/`'.-` allowlist — rejects injection attempts before they ever reach a `RegExp`), `limit` (max 20), `country`, `city`, `internationalOnly`, `activeOnly`.

---

## 4. Ranking Engine (§13, verified against the doc's own example)

| Tier | Score | Real implementation |
|---|---|---|
| Exact IATA/ICAO | 100 | Direct equality |
| Exact airport name | 95 | Direct equality |
| Exact city name | 90 | Direct equality |
| IATA prefix | 88 | `startsWith` |
| City prefix | 85 | `startsWith` |
| Airport name prefix | 82 | `startsWith` |
| Contains | 70 | Substring |
| Phonetic | 55 | Soundex equality (catches "Karachy" → "Karachi") |
| Fuzzy | 30–49 | Levenshtein similarity ≥ 0.6 |
| No match | 0 | Never a fabricated non-zero baseline |

Verified directly against the doc's own §12 example: querying `"Kar"` scores both `KHI` (Karachi) and `FKB` (Karlsruhe) at the same city-prefix tier (85), matching the doc's response showing both airports returned for that query.

---

## 5. Caching (§14)

`CacheManager`, TTL `AIRPORT_SEARCH_CACHE_TTL_SECONDS` (default 3600 = 1 hour) — deliberately shorter than EXT-013's own 24-hour reference-data cache, matching the doc's explicit distinction between the two tiers.

---

## 6. Validation (§10/§18, as implemented)

| Doc rule | Implementation |
|---|---|
| Search Query Required | `INVALID_REQUEST` 400 |
| Minimum Length = 2 / Maximum Length = 100 | Enforced from `AIRPORT_SEARCH_MIN_QUERY_LENGTH`/`_MAX_QUERY_LENGTH` |
| Invalid Characters | Unicode-aware allowlist regex, checked before any `RegExp` is built from user input (also prevents ReDoS/regex-injection via `escapeRegExp` on `country`/`city` filters) |
| Maximum Results = 20 | Clamped from `AIRPORT_SEARCH_MAX_RESULTS` |
| Only Active Airports Returned | `isActive: true` by default (§11 "Inactive airports hidden by default") |

---

## 7. AI Integration (§16, as implemented)

Extended the existing `reference_data_lookup` AI tool (from EXT-013) with a new `type: "airport_search"` mode, rather than adding a second tool for what is fundamentally the same read-only lookup capability. Returns `{ results, ambiguous }` — `ambiguous` is a **real derived signal** (true when 2+ distinct cities score within 5 points of the top result), not a guessed flag, giving the AI Assistant genuine support for §16's "Detect ambiguous airport searches." The doc's own worked example ("I want to fly from Karachi" → "Jinnah International Airport (KHI)") now resolves correctly through this tool.

---

## 8. Domain Events (§20)

- `AirportSearchPerformed` — every search, cached or not.
- `AirportSearchCached` — additionally published specifically when served from cache.
- `AirportSuggestionSelected` — published by a new, intentionally minimal `POST /api/v1/reference/airports/search/select` endpoint. The doc names only one GET endpoint in §5, but lists this event in §20 — without somewhere to fire it, it could never be real. Kept deliberately small: an audit-log entry + event, not a new heavy model, for future ranking-tuning feedback.

---

## 9. Security & Logging

JWT, `reference.read` RBAC, tenant isolation, full `AuditLogModel` entry per search/selection, the existing router-level rate limiter (already generous for this file per EXT-013's own "hit more than flight search" framing), and input sanitization as described in §6.

---

## 10. Completion Status

- **Status**: Production Ready
- **Document ID**: `EXT-014`
- **Depends On**: `EXT-013 — Airport & Airline Reference Data`
- **Next Document**: `EXT-015 — Amadeus Flight Inspiration API`
