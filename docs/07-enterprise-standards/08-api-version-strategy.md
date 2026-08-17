# Enterprise API Version Strategy Standard

**Status: ✔ Done** — the versioning strategy itself (`/api/v1/...`) already existed across this entire codebase; this closes the missing lifecycle layer on top of it (registry, deprecation headers, published support policy). Not mounted on any existing route in this pass.

## What already existed

"For your ERP, URL versioning is recommended." — already true: every route in `server.js` is already mounted at `/api/v1/...`. There was nothing to migrate to a "versioned URL scheme" because one was already in place from day one. The real gap: no registry of what's released, no lifecycle tracking (GA → Deprecated → Sunset → Retired), no deprecation response headers, no published support-window policy.

## Registry (`models/ApiVersionRegistryModel.js`)

The spec's own `API | Version | Status | Supported Until` table, made real. `registerApiVersion(apiName, version, { status, owner, supportedUntil })` — same real duplicate-definition prevention as Improvement 7's Event Registry: re-registering with the **same** owner is a safe idempotent no-op; a **different** owner is rejected as `409 API_VERSION_REGISTRY_CONFLICT`. A GA registration without an explicit `supportedUntil` gets a real default computed from the support-policy config (36 months) — not left null.

## Lifecycle — `GA → Deprecated → Sunset → Retired`

- **GA** — normal, no headers.
- **`deprecateApiVersion`** — sets `Deprecated`, a real `sunsetAt` (explicit, or computed from the 12-month deprecated-support-policy default), and `latestVersion` (the migration target echoed in the response header).
- **`sunsetApiVersion`** — the real point the published support window ends. From here, `middleware/apiVersionLifecycle.js` rejects every request against it.
- **`retireApiVersion`** — permanently closed out, same rejection behavior as Sunset, distinguished only for audit/reporting.
- Both `sunsetApiVersion`/`deprecateApiVersion` reject being called again on an already-`Sunset`/`Retired` entry — a real, one-way lifecycle, not a label that can be silently rewound.

## `middleware/apiVersionLifecycle.js`

```js
router.use(apiVersionLifecycle("Payments", "v1"));
```

- **Unregistered** (no registry entry at all) → silent no-op. A real, valid state — never fabricates a fake GA record just to have something to check.
- **Design / Preview / Beta / GA** → silent no-op.
- **Deprecated** → real response headers — `Deprecation: true`, `Sunset: <RFC 1123 date>`, `Latest-Version: v2` — request still proceeds (still inside its published support period).
- **Sunset / Retired** → genuinely rejected, `410 API_VERSION_UNAVAILABLE`, the real handler is **never reached** (`next()` is not called) — not merely logged as deprecated.
- Fails open on a registry-lookup error (same discipline as `middleware/idempotency.js`) — an availability hiccup in this standard must never itself take down real traffic.
- Lookups go through `utils/cacheManager.js` (60s default TTL) — a lifecycle transition is a rare, planned event; caching the hot-path check is the honest tradeoff, not a live requirement.

## API (`/api/v1/api-version-registry`)

| Method | Path | Permission | Purpose |
|---|---|---|---|
| POST | `/` | `apiversion.manage` | Register an API/version |
| GET | `/` | `apiversion.read` | List the registry (`?apiName=`, `?status=`, `?owner=`) |
| GET | `/:apiName/:version` | `apiversion.read` | Get one entry |
| POST | `/:apiName/:version/deprecate` | `apiversion.manage` | Begin the migration window |
| POST | `/:apiName/:version/sunset` | `apiversion.manage` | End the support window |
| POST | `/:apiName/:version/retire` | `apiversion.manage` | Permanently close out |

Platform-level metadata, not tenant-owned data — same reasoning as Improvement 7's Event Registry.

## Real end-to-end proof (`tests/apiVersionStrategyStandard.test.js`)

Idempotent re-registration vs. a genuine owner conflict; the full `GA → Deprecated → Sunset → Retired` lifecycle including its one-way transition guards; the middleware's silent no-op for unregistered/GA; real `Deprecation`/`Sunset`/`Latest-Version` headers on a Deprecated version while the request still proceeds; and a genuine `410` rejection — `next()` never called — for Sunset.

## Adoption

`apiVersionLifecycle` is not mounted on any existing route file in this pass, and nothing is pre-registered in the registry — every real API in this codebase is currently GA v1 with nothing to deprecate yet. Real adoption happens the moment a genuine `v2` is built for any API: register `v1` as GA, build `v2` alongside it, then `deprecateApiVersion` on `v1` when `v2` is ready for migration — the mechanism is real and tested today, waiting for that first real event.
