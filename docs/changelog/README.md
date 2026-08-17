# API Changelog

Enterprise OpenAPI / Swagger Standard (`docs/07-enterprise-standards/15-openapi-sdk.md`) — "Every release should publish: Added Endpoints, Changed Fields, Deprecated APIs, Breaking Changes, Migration Notes, Bug Fixes." This file tracks that history against the real, live OpenAPI document (`docs/openapi/v1.yaml`, `GET /openapi.json`/`/openapi.yaml`), not a separate marketing changelog — every entry below corresponds to an actual, verifiable change in `config/swaggerConfig.js` and/or a real route.

Documentation governance rule: this file is updated as part of the SAME change that adds/changes/deprecates a public endpoint — never as a follow-up after deployment (see "Documentation Governance" in the standard's own doc).

## v1 — 2026-08-16

Initial published OpenAPI contract for `docs/openapi/v1.json`/`v1.yaml`.

**Added**
- `GET /openapi.json`, `GET /openapi.yaml` — the machine-readable contract, served from the same `swaggerSpec` object `/api-docs` renders.
- Reusable schema components: `ErrorResponse` (rewritten to match the real Enterprise Standard Error Contract — `code`/`category`/`severity`/`httpStatus`/`correlationId`/`timestamp`/`details`, Improvement 4), `PaginatedResponse` (Enterprise Pagination Standard, Improvement 9), `EnterpriseEventEnvelope` (Enterprise Event Versioning Standard, Improvement 7 — also the real Webhook payload shape, Improvement 14).
- Reusable rate-limit response headers (`X-RateLimit-Limit`/`X-RateLimit-Remaining`/`X-RateLimit-Reset`/`Retry-After`, Enterprise API Rate Limiting Standard, Improvement 13) under `components.headers`.
- `POST /payments` — the first fully-documented endpoint using the real per-route JSDoc pattern (`routes/FinanceRoutes.js`, scanned by `swagger-jsdoc`), including request/response examples, every real error status, and cURL/JavaScript code samples (`x-code-samples`).

**Changed**
- `ErrorResponse`'s `data` shape corrected — it previously showed no `data` field at all, which didn't reflect what `sendStandardError` (Improvement 4) has actually been sending since that standard shipped.

**Deprecated / Breaking Changes**
- None. `v1` is the first published contract snapshot; nothing existed before it to deprecate or break.

## Adding a future entry

1. Make the real route/schema change first.
2. Run `npm run generate:openapi` to refresh `docs/openapi/v{N}.json`/`.yaml` and `docs/sdk/typescript/index.d.ts` from the live spec.
3. Add a dated entry above (newest first) under the correct `vN` heading — bump `info.version` in `config/swaggerConfig.js` first if the change is breaking (see `docs/migration-guides/README.md`).
