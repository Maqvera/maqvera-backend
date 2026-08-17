# Migration Guides

Enterprise OpenAPI / Swagger Standard — "Release notes and migration guides MUST accompany breaking changes." This directory holds one file per breaking transition, named `vN-to-vM.md`.

**Current state: empty.** No breaking change has happened yet — `v1` (`docs/openapi/v1.yaml`) is this codebase's only published OpenAPI contract, and the URL-level API itself (`/api/v1/...`) has never had a `v2` registered anywhere (`docs/07-enterprise-standards/08-api-version-strategy.md`'s own `ApiVersionRegistryModel` has no non-`v1` entries). Nothing here is fabricated ahead of an actual v2 — a migration guide for a version that doesn't exist would mislead an integrator more than an honestly empty directory.

## How a real migration guide gets written here, when the time comes

1. A breaking change is proposed against a registered API (Enterprise API Version Strategy Standard, Improvement 8: `registerApiVersion`/`deprecateApiVersion`/`sunsetApiVersion`).
2. The new version's OpenAPI contract is generated (`npm run generate:openapi` after bumping `config/swaggerConfig.js#info.version` and/or adding the new version's own path definitions) — producing a real, separate `docs/openapi/v{N+1}.yaml` alongside the untouched `v{N}.yaml` ("never overwrite old documentation").
3. `v{N}-to-v{N+1}.md` is added here, listing: every field/endpoint removed or renamed, every response shape change, the real `sunsetAt` date from the API Version Registry, and concrete before/after request examples.
4. `docs/changelog/README.md` gets a dated entry linking to this file.
