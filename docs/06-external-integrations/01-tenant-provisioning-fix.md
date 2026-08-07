---
title: Fix — Auth module is single-tenant, rest of the system is multi-tenant
document_id: TENANT-FIX-01
version: 1.0.0
status: Production Ready (scoped)
module: Auth / Tenant Provisioning
---

# Fix — Auth module is single-tenant, rest of the system is multi-tenant

---

## 1. Root Cause (confirmed)

`Signup` never accepted or created a tenant — `resolveDefaultDomainAssignments()` always assigned every new signup to whichever tenant was named in `DEFAULT_TENANT_KEY`, or failing that, whichever tenant happened to be oldest in the database. `TenantModel.create` was never called anywhere at runtime — the only tenant that could ever exist was the one hand-inserted by `scripts/seedAuthDomain.js`. Every real downstream controller (Customer, Booking, User, ...) already filtered correctly by `req.auth.tenantId` — the bug was isolated to the provisioning entry point.

## 2. What Was Built

- **`POST /auth/setup`** (`SetupTenant` in `controllers/Auth.js`) — public, rate-limited, self-service tenant registration. Creates `Tenant` → `Branch` ("MAIN") → tenant-scoped `Administrator` role → admin `User`, sequentially with manual compensating deletes on failure (no Mongoose transactions are used anywhere in this codebase — standalone MongoDB is assumed). Fires `TenantProvisioned`.
- **`Signup` fixed** — now requires an explicit `tenantKey` in the request body (or an operator-configured `DEFAULT_TENANT_KEY` for a deliberate single-tenant on-prem mode), validated against a real active `Tenant`. The "pick oldest active tenant" implicit fallback is gone entirely.
- **`utils/authDomainDefaults.js`** (new) — single source of truth for the permission catalog and `ensureAdministratorRole(tenantId)`, shared by `SetupTenant` and `scripts/seedAuthDomain.js` so they can't drift.
- **`middleware/validateRequest.js`** — `authSchemas.setupTenant` (companyName, tenantKey slug, branchName, admin credentials).

## 3. A second bug found during implementation

`models/Branchmodel.js` had `branchKey` globally unique — since every new tenant's first branch is named `"MAIN"`, a second tenant's `POST /auth/setup` call would crash with a duplicate-key error the moment two tenants existed, defeating the entire point of self-service onboarding. Fixed to `{ tenantId, branchKey }` compound-unique, alongside the equivalent pre-existing bug on `Role.name` (see `02-tenant-isolation-audit.md` §7). `scripts/migrateTenantScopeUniqueness.js` drops both stale global-unique indexes.

## 4. Verification

`tests/authSetup.test.js` — Joi schema validation (missing fields, weak password, invalid tenantKey slug) plus live end-to-end checks against a real MongoDB: successful setup persists a real Tenant/Branch/User, duplicate tenantKey rejected with 409, Signup with no resolvable tenant rejected with 422 and creates no user. Full suite held at 58/58 after this fix (was 49/49 before).

## 5. Completion Status

- **Status**: Production Ready
- **Next**: `02-tenant-isolation-audit.md` — audits whether the same disease exists outside Auth, and introduces branch/role-scoped access control (`getAccessScope`).
