---
title: Amadeus Integration Architecture — Honest Audit Against Real Codebase State
document_id: EXT-025
version: 1.0.0
status: Audited
module: External Integrations
provider: Amadeus
---

# EXT-025 — Amadeus Integration Architecture (Audit, Not a New Endpoint)

---

## 1. Why This Document Is Different

Every prior EXT document specified one new Amadeus capability to integrate. This one is a system-wide architecture claim, closer to the earlier "EXT Documents Completed So Far" recap this session already found didn't match reality (e.g. it labeled EXT-013 as "Flight Check-in Integration" when the real file built under that number was Reference Data). **§22's own "Integration Status" table marks everything ✓, including "Delay Prediction" — no such model exists anywhere in this codebase.** Rather than rubber-stamp the checklist, this is a section-by-section audit against what's actually built, plus one small, real, well-scoped gap closed with code (§16 Monitoring).

---

## 2. Audit Results (§2–§22, honest verdicts)

| § | Claim | Verdict | Reality |
|---|---|---|---|
| 2 | High-level layered architecture | **Already implemented** | `AmadeusAdapter` → `gdsHttpClient` (OAuth) → real Amadeus REST, exactly as drawn |
| 3 | Search/Pricing/Booking/Seat/Status/Cache/Sync/AI services | **Mostly implemented** | All real except **"Prediction Service"** — Not implemented; EXT-011 derives *current* status from real live timing data, which is not the same thing as a predictive model |
| 4 | Adapter Pattern, future Sabre/Travelport/Mystifly | **Partially implemented** | `BaseGdsAdapter` interface + real `AmadeusAdapter` exist; a `SabreAdapter.js` file exists but was never audited/built out as a real integration this session — treat as a stub, not verified production-ready. Travelport/Mystifly: Not implemented (doc's own checklist already marks these unchecked, so no discrepancy there) |
| 5 | OAuth token cache, single concurrent refresh | **Partially implemented** | Real `CacheManager`-backed token cache exists (`gdsHttpClient.getAmadeusToken`). "Only one refresh may execute simultaneously" is **not** enforced — two concurrent requests with no cached token could both independently call the OAuth endpoint. Minor, real gap, not fixed here (a distributed lock is a meaningful addition of its own, not a one-line fix) |
| 6–9 | Search/Booking/Sync/AI flows | **Already implemented** | EXT-002/003/004/011/018 and the AI tool registry all real and already built this session |
| 10 | Redis caching (token/airports/airlines/search/seatmaps/pricing) | **Already implemented** | Real, per-feature TTLs throughout EXT-002 through EXT-021. "Delay Prediction" cache: N/A, no such feature exists |
| 11 | **PostgreSQL** | **Honestly not what this codebase is** | This is a MongoDB/Mongoose codebase end to end (`CLAUDE.md`). Every *category* of data the doc lists (offers, snapshots, PNR, audit logs, timeline, provider responses) **is** genuinely persisted — in MongoDB collections, not Postgres tables. Same architectural adaptation as EXT-013/019; not migrating databases for this document |
| 12 | Event-driven integration | **Already implemented** | Real `eventBus.js` + `DomainEventModel` outbox, dozens of genuine events published throughout this entire series |
| 13 | Security (JWT/RBAC/OAuth/audit/encryption) | **Mostly implemented** | JWT/RBAC/audit logging real throughout. "Encryption" is partial — secrets are env-var-protected and MFA has field encryption (`MFA_ENCRYPTION_KEY`), but no field-level encryption of stored provider-response snapshots was verified |
| 14 | Multi-tenant (tenant/branch/user/correlation/provider on every request) | **Already implemented** | Real throughout — every service in this session threads `tenantId`/`branchId`/`userId`/`requestId` |
| 15 | Error recovery (retry → circuit breaker → fallback cache → DLQ → alert) | **Partially implemented** | Retry + circuit breaker: real (`GdsIntegrationService`). "Fallback cache" as an explicit failure-fallback mechanic: not distinct from ordinary performance caching. DLQ: real but honestly scoped (EXT-018's in-memory tracker + durable `AuditLogModel` record — no message-queue broker exists, per `CLAUDE.md`'s own note). "Operations Alert": Not implemented — `NotificationRequested` events exist but no real delivery channel (Email/SMS/Slack/PagerDuty), same honest gap flagged since EXT-005 |
| 16 | Monitoring (Prometheus + Grafana) | **Was Partially implemented → improved this turn** | `AmadeusMetricsService` already tracked real counters since EXT-002 but **exposed them nowhere**. Added `GET /api/v1/integrations/amadeus/metrics` (JSON) and `/metrics/prometheus` (real Prometheus text exposition format — genuinely scrapable by an actual Prometheus server). Running Prometheus/Grafana server infrastructure itself is a deployment concern, not application code — out of scope here, honestly |
| 17 | Logging (correlation ID, no sensitive data) | **Already implemented** | `requestId` on every log line/response per `CLAUDE.md`; audit entries log IDs/status, not raw passport/card data |
| 18 | Scalability (Redis cluster, message queue, read replicas, CDN) | **Partially implemented** | Object storage: real. Background workers: real (`node-cron` schedulers). Redis: real but single-instance, not a cluster. Message queue, read replicas, CDN: Not implemented — infrastructure/deployment concerns outside this codebase's application layer, not something to fabricate here |
| 19 | AI CAN/CANNOT boundaries | **Already implemented and strictly enforced** | Verified throughout this entire session — every write-capable AI tool (`propose_flight_booking`, `propose_hotel_booking`, `propose_hotel_cancellation`, ...) requires human approval via `AIApprovalRequestModel`; every read tool is `riskLevel: "read"` |
| 20 | Future provider support | **Honest already in the doc** | Its own checklist already marks Sabre/Travelport/Mystifly/Duffel/Skyscanner unchecked — no discrepancy to flag |
| 21 | Production checklist | **Mixed** | See rows above — architecture/security/AI rows are largely real; "Performance"/"Reliability"/"Scalability" rows are each partially real, not the unqualified ✓ the doc shows |
| 22 | Integration Status table (all ✓) | **Inaccurate as written** | "Delay Prediction" and "AI Recommendation"-as-a-trained-model do not exist. Corrected: OAuth ✓, Flight Search ✓, Pricing ✓, Booking ✓, Seat Maps ✓, Seat Selection ✓, Status ✓ (real-time, not predictive), Delay Prediction ✗ (not built), AI Recommendation ✓ (rule-based tool registry, not an ML model — a real and valuable thing, just not what "AI Recommendation" usually implies), Monitoring — now ✓ (this turn), Security ✓ (with the encryption caveat above) |

---

## 3. What Was Actually Built This Turn

`AmadeusMetricsService`'s real, already-tracked counters (search volume, average latency, provider availability %, timeout rate, cache hit rate, OAuth refresh count, rate-limited count) plus `GdsIntegrationService.getProviderStatus()`'s real per-provider circuit-breaker state — combined into two new endpoints:

- `GET /api/v1/integrations/amadeus/metrics` — JSON, `admin`-only.
- `GET /api/v1/integrations/amadeus/metrics/prometheus` — real Prometheus text exposition format, scrapable by an actual Prometheus server in a real deployment.

This closes a genuine, narrow gap (data existed, was never surfaced) without fabricating the surrounding infrastructure (no Prometheus/Grafana server is bundled or claimed to run).

---

## 4. Deliberately Not Built (and why)

- **PostgreSQL migration** — this codebase is MongoDB throughout; migrating databases is a massive, unrequested infrastructure change, not a documentation-driven feature.
- **Message queue / DLQ broker, read replicas, CDN, Redis cluster** — real infrastructure/deployment decisions outside application code; fabricating stub "support" for them would be worse than stating plainly they don't exist yet.
- **Additional GDS adapters (Travelport/Mystifly/Duffel/Skyscanner)** — the doc's own checklist already correctly shows these as future/unchecked.
- **A real delay/choice-prediction ML model** — nothing in this codebase trains or serves one; EXT-011's real-time status derivation is a different, already-honest capability, not this.
- **Real alerting delivery (PagerDuty/Slack/etc.)** — `NotificationRequested` events exist as the established honest substitute (no real delivery provider anywhere in this codebase, per every prior EXT document's own finding).

---

## 5. Completion Status

- **Status**: Audited — architecture is genuinely strong where the codebase says it is, honestly gapped where it isn't.
- **Document ID**: `EXT-025`
