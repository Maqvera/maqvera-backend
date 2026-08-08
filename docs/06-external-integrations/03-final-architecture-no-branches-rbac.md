---
title: Final Architecture — Company-as-Tenant, No Branch Isolation, Admin-Configurable RBAC
document_id: TENANT-FIX-03
version: 1.0.0
status: Production Ready
module: Auth / Tenant Isolation / RBAC
supersedes: docs/06-external-integrations/02-tenant-isolation-audit.md §7-8 (branch-based isolation)
---

# Final Architecture — Company-as-Tenant, No Branch Isolation, Admin-Configurable RBAC

---

## 1. Why this document exists

`01-tenant-provisioning-fix.md` and `02-tenant-isolation-audit.md` built out a two-dimensional isolation model: tenant (company) **and** branch, with `Role.scope` (`"branch"` | `"tenant"`) determining whether a caller's queries were restricted to their own `branchId` or opened up to their whole tenant.

A subsequent, explicit architectural decision reversed the branch dimension: **the company (tenant) is the only data-isolation boundary that exists in this system.** There is no branch-level data ownership, no branch-scoped role, and no API that restricts or widens access based on `branchId`. Every authenticated user of a tenant shares that tenant's business data. What differs between users is not *which records they can see*, but *which actions they're permitted to take* — governed entirely by Role-Based Access Control (RBAC).

This document records what changed, why, and the resulting model — the authoritative reference for "why is there no branch filtering here" anywhere in the codebase or its tests.

## 2. What changed

- **`utils/accessScope.js`** — `getAccessScope(req)` now returns `null` (no authenticated tenant — caller must 403) or `{ tenantId }`. It never returns a `branchId`. `applyOptionalBranchFilter` no longer exists (see §6 — it was removed entirely once the Branch concept itself was removed, rather than kept as a no-op passthrough).
- **`models/Rolemodel.js`** — the `scope: "branch" | "tenant"` field is removed entirely. Roles gained `description` (String) and `isSystemRole` (Boolean — protects the seeded `Administrator` role from deletion). `Role.name` remains unique **per tenant** (compound `{tenantId, name}` index) — each company independently owns and edits its own role catalog.
- **`middleware/authenticateAccessToken.js`** — resolves the caller's role into `req.auth.permissions` (a flat permission-string array), not a scope. Every downstream authorization decision reads `req.auth.permissions`, never `req.auth.roleScope`.
- **`controllers/Auth.js`** — `GET /auth/me` no longer returns `roleScope`; it returns `permissions` instead.
- **Every one of the ~15 controllers converted to `getAccessScope` in the prior audit** (`CustomerController`, `VisaController`, `TravelIncidentController`, `BookingController`, `UserController`, and the rest) needed **zero individual edits** for this change to take effect — they all spread `...scope` into their Mongo filters, so simplifying the shared `getAccessScope` function to drop the branch dimension automatically and safely removed branch restriction everywhere at once. This was the payoff of centralizing that decision in one function in the first place.
- **`branchId` fields have since been removed from models entirely** — see §6. At the time this section was originally written, `BranchModel`, `Branch` creation at `POST /auth/setup`, and `branchId` fields on documents (Customer, Booking, VisaCase, etc.) still existed as descriptive/organizational metadata, never read to gate a query or a write. That metadata-only field has since been deleted outright, along with the `Branch` model and its two remaining endpoints — this document originally under-stated how far the removal would eventually go.
- **New: `controllers/RoleController.js` + `routes/RoleRoutes.js`** (`/api/v1/roles`) — the admin-configurable RBAC surface that didn't exist before. A company admin can:
  - `GET /roles/permissions` — list the real, seeded permission catalog (`PermissionModel`, seeded via `utils/authDomainDefaults.js`'s `DEFAULT_PERMISSIONS`), grouped by module (inferred from the permission key's `module.action` naming convention, e.g. `customer.read` → module `customer`).
  - `GET /roles`, `GET /roles/:roleId` — list/inspect the tenant's own role catalog. Never sees another tenant's roles.
  - `POST /roles` — create a custom role (e.g. "Sales Manager", "Visa Officer", "Finance", "Support") with an explicit, validated set of permission keys. Unknown permission keys are rejected (`422`); duplicate names within the same tenant are rejected (`409`).
  - `PATCH /roles/:roleId` — edit a role's `permissions`/`description`/`status`. Name is immutable. Invalidates the cached `role:permissions:${tenantId}:${name}` entry (`CacheManager`) so the new permission set takes effect immediately, not after cache expiry.
  - `DELETE /roles/:roleId` — delete a role, blocked (`403`) if it's the seeded system `Administrator` role (`isSystemRole: true`) or if any user/employee is still assigned it.

## 3. The resulting model

- **Tenant isolation (who can see this record at all)**: absolute, enforced by `getAccessScope(req)` → `{ tenantId }` on every query. A user of tenant A can never see, list, count, or act on tenant B's data, regardless of any query parameter, request body field, or header — confirmed by `tests/accessScopeRegression.test.js`, `tests/accessScope.test.js`, `tests/bookingIsolation.test.js`, `tests/userIsolation.test.js`.
- **Company-wide sharing (who among tenant A's users can see this record)**: everyone. There is no second filter. A newly-hired employee sees the exact same customers, bookings, and visa cases as everyone else in their company, from day one — there is no office/branch attribute left on a user or a record to even differ by (see §6).
- **Action authorization (what a user is allowed to do)**: entirely RBAC. Every write/sensitive-read endpoint checks `req.auth.permissions` for the specific permission key(s) that action requires (e.g. `customer.delete`, `booking.create`). A company admin controls this per role via `/api/v1/roles`, with no code change or redeploy required — genuinely admin-configurable, not a hardcoded array.
- **Future-proofing**: any new module follows the same two rules — filter every query through `getAccessScope(req)` for tenant isolation, and gate every action through a `module.action` permission key checked against `req.auth.permissions`. No new isolation dimension needs to be invented per module.

## 3.1 Follow-up fix: two remaining hardcoded role-name gates found on re-verification

A subsequent audit (re-checking every controller and the AI tool registry against this document's own model, not just the ones already migrated in the initial pivot) found **two files still gating access by a hardcoded role-name set instead of `req.auth.permissions`** — the exact anti-pattern this document forbids:

- **`controllers/VisaDashboardController.js`** — had its own `MANAGEMENT_ROLES` `Set` and read `req.auth?.role` directly to decide `managementOnly`/branch-wide dashboard access, and separately referenced the removed `getAccessScope(req).branchId` (always `undefined` post-pivot, dead code). Fixed: management-tier dashboards (executive, finance, compliance, ai-insights) now require the new `visa.dashboard.management` permission key (or `admin`); the base `visa.read` permission gates every dashboard; `branchId` is now treated purely as an optional, descriptive query-narrowing param with no isolation semantics, matching every other migrated controller.
- **`services/ai/AIToolRegistry.js`** — the `get_revenue_dashboard` AI tool was the one outlier among ~25 registered tools still using a hardcoded `MANAGEMENT_ROLES` `Set` (`requiredRoles: [...MANAGEMENT_ROLES]`, checked ad-hoc inside its own handler) instead of the `requiredPermissions`/`hasPermission(...)` pattern every other tool already used. Fixed the same way: gated on the new `visa.dashboard.management` permission.
- Added `visa.dashboard.management` to `utils/authDomainDefaults.js`'s `DEFAULT_PERMISSIONS` (seeded automatically for every tenant, and assignable to custom roles via `/api/v1/roles` like any other permission key).
- **New permanent regression guard**: `tests/accessScopeRegression.test.js` now also fails the build if any file under `controllers/`, `middleware/`, or `services/` (recursively) declares a `const *ROLES* = new Set(...)`/`[...]` — the exact shape both bugs took — closing the gap that let this reappear after the initial pivot.
- Updated `docs/05-api/06-visa-api.md` (Part 12), `docs/05-api/06-visa-dashboard-analytics-api.md`, and `docs/05-api/06F-ai-travel-assistant-api.md` to describe the permission-based gate instead of "management role."

This is the kind of drift the "future-proof" requirement (§3, "Future-proofing") exists to catch: a feature built after the initial pivot (or simply missed by it) can silently reintroduce role-name-based gating unless every new module is checked against the same rule, and now is, automatically.

## 3.2 Follow-up fix: a real "shared data" breakage, not just an isolation leak

A third re-verification pass (checking every remaining `branchId`-shaped variable across the Visa write path, not just the ones already known) found a more severe bug than §3.1's dead role-name gates — this one actually **broke access to real, existing company data** rather than merely leaving stale code around:

- **`controllers/VisaController.js`'s `resolveWriteBranchId(scope, req, fallback = "main")`** — used by nearly every Visa sub-resource write endpoint (`uploadVisaCaseDocument`, `startDocumentVerification`, `createEmbassySubmission`, `scheduleVisaCaseAppointment`, `receiveVisaCasePassport`, `reportVisaCaseIncident`, `addVisaCaseNote`, plus the reads `getVisaCaseTimeline`/`getVisaCaseAIContext` which used a separate `scope.branchId || "main"` inline). Since `getAccessScope(req).branchId` is always `undefined` post-pivot, this **always** resolved to the literal string `"main"` unless the client happened to pass a matching `branchId` in the request body. That value then flowed into several services' *existence-lookup* filters for the visa case being acted on (`VisaService.getVisaCaseById`'s `if (branchId) filter.branchId = branchId`, `EnterpriseDocumentService.uploadVisaCaseDocument`, `DocumentVerificationService.startVerification`, `EmbassyProcessingService.createEmbassySubmission`, `SchedulingEngineService.scheduleAppointment`) — silently 404ing ("not found") any real visa case whose actual `branchId` wasn't literally `"main"`, for a fully-authorized, fully-permissioned caller.
- **`services/PassportTrackingEngineService.js`'s `receivePassport`** was worse still: it included `branchId` **unconditionally** in the lookup filter (`VisaCaseModel.findOne({ _id, tenantId, branchId, ... })`, no `if` guard at all), so passport receipt was broken for any non-`"main"` case regardless of what the controller passed.
- This directly violated requirement #3 ("Shared Business Data Within a Company... never duplicated per user [or branch]") — worse than branch isolation, this was **branch-based data unavailability**, invisible in testing only because the test fixtures happened to use branch-name strings other than `"main"` for isolation tests but no test previously exercised these specific write endpoints end-to-end.
- **Fix**: `resolveWriteBranchId`'s default changed from `"main"` to `null`; `PassportTrackingEngineService.receivePassport`'s filter made conditional like every other lookup. Every affected service already had a secondary fallback (`branchId || visaCase.branchId || "main"`) for *stamping* new records, so passing `null` instead of a wrong `"main"` makes new sub-resources correctly inherit the parent case's real branch instead of being forced onto a wrong one. One additional gap found by this fix: `VisaService.addVisaCaseNote` passed `branchId` bare into `EnterpriseTimelineEngineService.recordManualNote` with no fallback of its own, and `TravelTimelineModel.branchId` is schema-`required: true` — a bare `null` failed that write's validation. Fixed by passing `branchId || visaCase.branchId` there too, matching the pattern used everywhere else in this file.
- **New regression test**: `tests/visaBranchAgnosticWrites.test.js` creates a real visa case tagged with a non-`"main"` branchId and proves `addVisaCaseNote`, `getVisaCaseTimeline`, and `getVisaCaseAIContext` all succeed against it.
- Also cleaned up stale/misleading comments still describing removed branch-restriction logic (as dead code, never a functional bug) in `TravelPlanController.js` and `TravelDashboardController.js`.

## 4. Verification

Full suite passing (72/72 at the time of this pivot, including the rewritten `tests/accessScope.test.js`, `tests/bookingIsolation.test.js`, `tests/userIsolation.test.js`, and the new `tests/roleManagement.test.js`; still 72/72 after the full Branch removal in §6). Live-DB tests explicitly prove: (a) two different users of the same tenant see the same shared data; (b) a second tenant never sees the first tenant's data under any circumstance; (c) a company admin can define a custom role with a real, validated permission set, edit it, and delete it once unused; (d) the seeded `Administrator` role cannot be deleted.

## 5. Completion status

- **Status**: Production Ready
- **Relationship to prior docs**: `01-tenant-provisioning-fix.md` remains accurate (tenant provisioning was never branch-related). `02-tenant-isolation-audit.md`'s §7/§8 branch-isolation rollout is superseded by this document — the branch-scoping behavior it describes building has been intentionally removed; its tenant-isolation findings and fixes (the `"default-tenant"`/`|| "default"` bugs, the public-route PII leak) remain valid and unaffected.

## 6. Full removal of the Branch concept (follow-up: this document's own §2 note above was itself corrected)

§§1-5 above describe the state where branch-based *isolation* was removed but `branchId` remained on documents as inert, descriptive metadata, and `BranchModel`/its two endpoints still existed. A subsequent, separate task went further and removed the Branch concept from the codebase **completely** — not just its enforcement, but the model, the field, and the endpoints themselves:

- **`models/Branchmodel.js` deleted.** The `Branch` collection/model no longer exists at all.
- **`branchId` removed from every schema that had it** — Customer, Booking/BookingHeader, VisaCase, TravelOperationsSummary, PassportTracking, AIPrompt, AIRoutingPolicy, AIABTest, Session, LoginHistory, User, and ~35 others. Any compound unique index that included `branchId` (e.g. `AIRoutingPolicyModel`'s `{tenantId, branchId, category}`, `VisaAnalyticsSummaryModel`'s `{tenantId, branchId, summaryDate}`) was rebuilt without it.
- **Endpoints removed entirely** (not just their isolation logic): `PATCH /users/:userId/branch` (`UpdateUserBranch`) and `GET /visa-dashboard/branch` (`getVisaBranchDashboard` / `VisaAnalyticsEngine.branchDashboard`).
- **`applyOptionalBranchFilter` removed from `utils/accessScope.js`** (it was previously kept as a no-op passthrough per §2 above — now deleted along with every call site, replaced by the plain scope object).
- **Signup/setup flow** (`controllers/Auth.js`) no longer creates a `"MAIN"` branch record or resolves/stamps `branchId` anywhere in the JWT payload, session, login history, or audit log.
- **Every `branchId`-based query param/filter** removed from the services that used it purely for optional narrowing (`KPIEngine`, `AnalyticsEngine`, `VisaAnalyticsEngine`, `EnterpriseDocumentService`, `PassportTrackingEngineService`, `AIPromptService`, `AIKnowledgeService`, `EmbassyProcessingService`, `VisaService`, `SchedulingEngineService`, `SearchEngineService`, `DocumentVerificationService`, `EnterpriseTimelineEngineService`, `AIModelRouterService`, `CustomerStatisticsEngine`, and others). Several of these removals also fixed real, pre-existing bugs where a stale `branchId` default (e.g. `"main"`) had turned into a silently-broken existence filter once the field stopped existing on the schema — see the commit history / PR description for the full list; the class of bug is the same one described in §3.2 above, just found more exhaustively this time.
- **Reversible cleanup migration**: `scripts/migrateRemoveBranchId.js` (`npm run migrate:remove-branch-id`) `$unset`s the now-dead `branchId` key from any pre-existing document that still physically carries it, across every affected collection. It never deletes a document or touches any other field, and is safe to re-run. Not run automatically — review before running against a real environment.
- **Tests**: `tests/visaBranchAgnosticWrites.test.js` deleted (it existed only to prove branch-agnostic behavior of a code path — `resolveWriteBranchId` — that no longer exists). `tests/accessScope.test.js`, `tests/authSetup.test.js`, `tests/roleManagement.test.js`, `tests/bookingIsolation.test.js`, `tests/userIsolation.test.js`, `tests/visaIncidentIsolation.test.js`, and several unit-test fixture files updated to drop `BranchModel`/`branchId` usage without changing what they otherwise assert about tenant isolation or RBAC.
- **§3.2 above is now fully superseded, not just fixed**: `resolveWriteBranchId` doesn't just have a safer default — it no longer exists, because there is no `branchId` left anywhere in the Visa write path for it to resolve.
