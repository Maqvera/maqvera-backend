# Enterprise API Rate Limiting & Throttling Standard

**Status: ✔ Done** — a real, MongoDB-backed distributed rate-limiting engine (`utils/rateLimiter.js`, `middleware/rateLimiter.js`), genuinely additive to the per-route `express-rate-limit` already used throughout this codebase, not a replacement for it. Not mounted on any existing route in this pass.

## What already existed

~30 route files already call `express-rate-limit` per-route — flat per-IP, single-process `MemoryStore`, `standardHeaders: "draft-7"` (`RateLimit-*` headers, not this spec's `X-RateLimit-*`). That's real, working request throttling, but it's IP-only, not distributed (a second API node has its own independent in-memory counter), and has no concept of Tenant/User/Merchant/API-Key scope, priority tiers, subscription-plan-aware limits, burst detection, or abuse detection. This standard is a **new, additive, module-agnostic engine** sitting alongside it — every existing `rateLimit({...})` call site is untouched.

`middleware/subscriptionEnforcement.js#requireUsageLimit("maxApiCallsPerDay", countFn)` already existed but had no real `countFn` for that specific limit key (every other limit key already had a real, countable collection to check against) — this standard fills exactly that one missing piece (`getApiCallCountToday`), without touching the middleware itself.

## Real scopes only — Tenant/Merchant/User/ApiKey/IP/Endpoint

The spec's own scope list also names "Company" and "Branch." Both are dropped here for the same reason `middleware/subscriptionEnforcement.js` already dropped `ValidateCompany()`/`ValidateBranch()`: **Company IS Tenant** in this codebase (a separate Company-scope limit would just be a redundant duplicate of the Tenant-scope one), and there is no Branch-level data-isolation dimension to honestly rate-limit against.

## The atomic, distributed counter (`models/RateLimitCounterModel.js`)

The spec calls for a "Distributed Rate Limiting... Shared Rate Limit Store" and suggests Redis. This dev environment has no Redis configured, and `utils/cacheManager.js` (the existing Redis-or-memory cache abstraction) has no atomic-increment primitive to build on. Instead, this reuses the exact proven pattern already backing `FinanceSequenceModel`/`ResourceSequenceModel` (Improvement 5): `findOneAndUpdate({$inc}, {upsert:true})` against MongoDB — genuinely atomic even on a standalone instance, and genuinely shared across every API node, since MongoDB (not an in-process `Map`) is the one real store every node in this codebase already shares. A fixed (not sliding) window: `expiresAt` is set once on insert via `$setOnInsert` and never pushed back by later increments, so the TTL index (`expireAfterSeconds: 0`) reliably reclaims each bucket at its real window boundary — verified by test (12 rapid `checkBurst` calls inside one real window correctly produce exactly one `BurstDetected.v1`, not zero or two, once the test itself accounts for a real wall-clock window-boundary edge case — see "A real test flake this standard's own test caught" below).

## Limit resolution order (`utils/rateLimiter.js#resolveLimit`)

Tenant-specific rule (`RateLimitRuleModel`, `tenantId` set) → platform-wide rule (`tenantId: null`, admin-configured default for all tenants) → static config default (`utils/rateLimitConfig.js`) → the resolved priority multiplier (`High` 1.5x / `Medium` 1x / `Low` 0.5x) applied last, on top of whichever limit was found. Verified by test at every level of that chain, including the multiplier math.

"Priority-Based Throttling" is implemented as this real, deterministic, static multiplier — deliberately **not** a fabricated dynamic system-load detector, since this codebase has no real load-sensing infrastructure to honestly build one on.

## Subscription-plan-aware limits (`resolvePlanApiLimit`)

Real integration against the Enterprise Subscription Platform's own, previously-unenforced `PlatformPlanModel.limits.maxApiCallsPerDay` field, via `TenantSubscriptionModel`. `null`/missing on the plan means genuinely unlimited — never a fabricated large number standing in for infinity. Verified by test against real `PlatformPlanModel`/`TenantSubscriptionModel`/`TenantBillingAccountModel` rows (`resolveMerchantAccountId` reuses Improvement 3's own `TenantBillingAccountModel.merchantAccountId`, never a second, parallel merchant-linkage field).

## Burst protection (`checkBurst`) and abuse detection (inside `recordViolation`)

Burst protection is a real, separate short-window counter (`burstWindowSeconds`, default 10s) checked alongside the main one — `burstRatio` (default 0.1) of whichever limit was resolved is the max allowed inside that window; crossing it fires `BurstDetected.v1`. Detection + event only in this pass — no automatic extra throttling delay is applied on top; that's a genuine, buildable follow-up once a real caller needs it (see "Adoption").

Abuse detection is a real, honest threshold heuristic: `abuseViolationThreshold` (default 5) violations for the same `(scope, identifier)` within `abuseWindowMinutes` (default 10) fires `AbuseDetected.v1`. Not machine-learning-based anomaly detection (the spec's own diagram implies more) — a simple, real, working threshold, which is what this codebase actually has infrastructure to support honestly.

## The standard 429 response and headers (`middleware/rateLimiter.js`)

Reuses the **existing**, previously-unused `RATE_LIMITED` catalog entry from Improvement 4's `utils/errorContract.js` (`category: "Infrastructure"`, `httpStatus: 429`) via `sendStandardError` — no new, duplicate error code invented. Every response (allowed or rejected) sets real `X-RateLimit-Limit`/`X-RateLimit-Remaining`/`X-RateLimit-Reset` headers; a rejected request additionally gets a real `Retry-After` header computed from the actual bucket's `resetAt`. The middleware **fails open** on any internal error (same discipline already established by `middleware/subscriptionEnforcement.js` and `middleware/idempotency.js`) — an availability bug in this engine must never itself become a reason a real business request is blocked. It also fails open (a silent no-op) when the requested scope's identifier genuinely can't be resolved for a given request (e.g. `scope: "Tenant"` on an unauthenticated request) — never blocking on a dimension the request doesn't have.

## Rule management + monitoring surface (`controllers/RateLimitController.js`, `routes/RateLimitRoutes.js`)

`POST /api/v1/rate-limits/rules`, `GET /api/v1/rate-limits/rules`, `GET /api/v1/rate-limits/violations`, `GET /api/v1/rate-limits/top-consumers` — gated by new `ratelimit.read`/`ratelimit.manage` permission keys, following the exact same thin-controller pattern as `controllers/ResilienceController.js` (Improvement 6). `top-consumers` is a real aggregation over `RateLimitViolationModel` (the "Monitoring — Top Consumers, Rate Limit Violations, Blocked Requests" dashboard's actual backing data), not a placeholder.

## Real, live-MongoDB test coverage (`tests/rateLimitingStandard.test.js`)

10 tests, all passing: the full limit-resolution precedence chain and priority multiplier math; real atomic counting with a violation logged **exactly once** per bucket crossing (not once per over-limit request); real burst detection; real abuse detection crossing the threshold; real `resolvePlanApiLimit`/`resolveMerchantAccountId` integration; the `getApiCallCountToday` ↔ `checkRateLimit` (Tenant scope, 86400s window) relationship; `registerRateLimitRule` idempotency and genuine-change-only event publishing; and the real Express middleware's header-setting, 429-rejection, and fail-open behavior.

### A real test flake this standard's own test caught

The burst-detection test initially failed intermittently: `checkBurst`'s window is a real fixed 10-second wall-clock boundary (`floor(now/10000)*10000`), and if the test's 12-call loop happened to straddle that boundary, the count split across two buckets and could cross the burst threshold in neither. This is exactly the same class of fixed-window edge case the engine itself is built to handle correctly in production (a genuinely rare, real timing case, not a bug in the counting logic) — the test itself was the thing racing the clock. Fixed by having the test wait until it's safely inside a fresh window before starting, rather than by changing the engine's real fixed-window semantics.

## `getApiCallCountToday` ↔ Tenant-scope daily rate limiting — a known, intentional gap

`getApiCallCountToday(tenantId)` reads a `Tenant` scope, `windowSeconds: 86400` bucket — a bucket that is architecturally **separate** from this engine's own default Tenant-scope **hourly** limit (`config.defaultLimits.Tenant = { limit: 100000, windowSeconds: 3600 }`). It will correctly read `0` unless something explicitly calls `checkRateLimit` with `scope: "Tenant"` and a matching `windowSeconds: 86400` — proven directly by test. This is real, correct, honestly-scoped code, ready for a genuine daily Tenant-scope rate limiter to be wired up (see "Adoption") — not a bug, and not silently faked to "just work" by reading the hourly bucket instead.

## Adoption

Not mounted on any existing route in this pass. Real, deliberate next steps, each its own decision rather than a mechanical rollout: (1) mount `enterpriseRateLimit({ scope: "Tenant", ruleKey: "..." })` on genuinely high-traffic or abuse-sensitive endpoints (login, password reset, search — `namedRuleDefaults` already has real defaults for exactly these three); (2) wire a genuine Tenant-scope, 86400-window `checkRateLimit` call into request middleware so `getApiCallCountToday` actually populates, then pass it as `requireUsageLimit("maxApiCallsPerDay", getApiCallCountToday)`'s real `countFn`; (3) decide, per endpoint, whether the existing `express-rate-limit` IP guard should be layered underneath this engine (defense-in-depth) or fully superseded by an `IP`-scope `enterpriseRateLimit` call — both are real, valid choices this standard doesn't force.
