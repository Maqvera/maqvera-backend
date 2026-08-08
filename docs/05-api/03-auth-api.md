# Auth API Contract

## Role-Based Access Control (RBAC)

`Role.name` (`models/Rolemodel.js`) is unique **per tenant**, not globally — each tenant owns and can independently customize its own role catalog via `POST/PATCH/DELETE /api/v1/roles` (see `controllers/RoleController.js`). **The tenant (company) is the only data-isolation boundary** — every authenticated user of a tenant shares that tenant's business data (customers, bookings, visa cases, etc.); there is no narrower dimension any user is restricted to. See `docs/06-external-integrations/03-final-architecture-no-branches-rbac.md` for the full rationale.

What a user may actually *do* is governed entirely by their role's `permissions` array (e.g. `"customer.read"`, `"booking.create"`, `"admin"`). `authenticateAccessToken` resolves the caller's role (tenant-scoped lookup: `{ tenantId, name }`) on every request and attaches the resolved list as `req.auth.permissions`, which `GET /auth/me` also echoes back as `permissions`. Controllers derive their Mongo filter from `getAccessScope(req)` (`utils/accessScope.js`), which returns `{ tenantId }` (or `null` if unauthenticated) — never a hand-rolled tenant filter read from a client-supplied header — and separately check `req.auth.permissions` for the specific permission key(s) an action requires. See `docs/05-api/05-customer-api.md`'s "Access Scope" section for a concrete example of the tenant-scoping behavior.

## Tenant Provisioning

### POST /api/v1/auth/setup

Public, rate-limited, unauthenticated. Self-service registration for a brand-new company: creates a real `Tenant` and the tenant's first user with its own tenant-scoped `Administrator` role (`scope: "tenant"`, independently editable per tenant — not shared with any other tenant's role catalog), in one call. This is the only runtime code path that creates a `Tenant` document — every other write path (`Signup`, `AcceptUserInvitation`) joins a tenant that already exists.

#### Business rules
- `tenantKey` must be unique across all tenants; a duplicate is rejected with `409`.
- `email` must be unique across all users (email is a global identity, not scoped per tenant); a duplicate is rejected with `409`.
- The new admin user is created unverified, exactly like `Signup` — an email verification link is issued and must be used before login (subject to the same `strictDomainAuth`/`emailVerified` gating as every other account).
- If any step after tenant creation fails, the tenant already created is deleted (no Mongoose transaction is used anywhere in this codebase — this is a best-effort compensating rollback, not a transactional guarantee).

#### Request body
```json
{
  "companyName": "Acme Travels",
  "tenantKey": "acme-travels",
  "username": "acmeadmin",
  "email": "admin@acmetravels.com",
  "password": "StrongPass1!"
}
```
- `tenantKey`: lowercase slug, `^[a-z0-9-]{3,40}$`.

#### Success response
```json
{
  "success": true,
  "message": "Company registered successfully. Please check your email for the verification link.",
  "data": {
    "id": "...",
    "username": "acmeadmin",
    "email": "admin@acmetravels.com",
    "tenantId": "acme-travels"
  }
}
```

## Signup

### POST /api/v1/auth/signup

Joins an **existing** tenant — it never creates one. `tenantKey` is required in the request body unless the deployment sets `DEFAULT_TENANT_KEY` (a deliberate operator opt-in for a genuinely single-tenant on-prem deployment, resolved explicitly — never an implicit "pick whichever tenant is oldest" fallback). A missing/invalid/inactive `tenantKey` (and no `DEFAULT_TENANT_KEY` configured) is rejected with `422`.

New companies should call `POST /auth/setup` instead. Existing tenants adding teammates should prefer the invitation flow (`InviteUser` / `AcceptUserInvitation`), which is already authenticated and tenant-scoped by construction.

## Session Management

### GET /api/v1/auth/sessions

Returns the authenticated user's owned sessions with pagination and metadata.

#### Business rules
- Only the authenticated user may view their own sessions.
- Sessions must be ordered by latest activity first.
- The current session must be clearly identifiable.
- Refresh and access tokens must never be exposed.

#### Query parameters
- `page` (optional, default `1`)
- `pageSize` (optional, default `20`)
- `status` (optional, default `active`)
- `sort` (optional, default `-lastActivityAt`)

#### Success response
```json
{
  "success": true,
  "data": [
    {
      "sessionId": "UUID",
      "device": "Windows Laptop",
      "browser": "Chrome",
      "ipAddress": "103.xxx.xxx.xxx",
      "createdAt": "UTC",
      "lastActivity": "UTC",
      "isCurrentSession": true,
      "status": "active"
    }
  ],
  "meta": {
    "page": 1,
    "pageSize": 20,
    "total": 1
  }
}
```

### DELETE /api/v1/auth/sessions/:sessionId

Revokes one specific authenticated session.

#### Business rules
- The session must belong to the authenticated user.
- Only active sessions should be revoked.
- Revoked sessions immediately lose access.

### POST /api/v1/auth/logout-all

Revokes every active session for the authenticated user.

#### Business rules
- The current session is also revoked.
- The user must authenticate again to continue using the platform.
