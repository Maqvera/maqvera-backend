# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev                          # start with nodemon (reads .env, connects MongoDB, boots enterprise services)
node --test "tests/*.test.js"        # run the full test suite (Node's built-in test runner)
node --test tests/visaWorkflowService.test.js   # run a single test file
```

There is no lint/build step. `npm test` is an unset placeholder — always use `node --test` directly. Tests use `node:test` + `node:assert/strict`, live flat in `tests/`, and mostly exercise config/service logic directly (few need a live MongoDB connection — check for `mongoose.connection.readyState` guards before assuming a DB is required).

Seed scripts (run once against a configured MongoDB instance):
```bash
npm run seed:auth              # roles, permissions, branches, departments
npm run seed:visa-workflow     # default visa workflow definition
npm run seed:incident-policy
npm run seed:timeline-policy
```

Copy `.env.example` to `.env` before running anything. `config/envValidator.js` hard-fails startup (`process.exit(1)`) if `ACCESS_TOKEN_SECRET`, `REFRESH_TOKEN_SECRET`, or `MFA_ENCRYPTION_KEY` are missing/insecure, and validates that storage-backend-specific vars (Cloudinary/S3) are present when `FILE_STORAGE_BACKEND` selects them.

## Architecture

Node.js/Express 5 modular monolith, ESM (`"type": "module"`), MongoDB via Mongoose. Multi-tenant and multi-branch **at the query boundary** — there's no separate DB per tenant; every document carries `tenantId`/`branchId` and every service method takes them as explicit params. See `docs/architecture/visa-enterprise-architecture.md` for the authoritative description of the domain boundaries below.

### Layering

`routes/*.js` → `controllers/*.js` → `services/*.js` → `models/*.js` (Mongoose). Routes wire `express-rate-limit` and `authenticateAccessToken` per-endpoint (not globally — check each route file for which paths are public; only genuinely tenant-agnostic reference/catalog data may be public — no endpoint touching a specific tenant's customer/case data is, see `docs/06-external-integrations/02-tenant-isolation-audit.md`). Controllers are thin: pull `tenantId`/`branchId`/`userId` off `req.auth` (the verified JWT — never a client-supplied header, never a hardcoded default), call into a service, and map thrown `Error` messages to HTTP status codes by substring-matching (`"not found"` → 404, `"already exists"` → 409, `"required"` → 400). Services hold the actual domain logic and are the only layer that touches models directly.

**All tenant-owned data access MUST go through `getAccessScope(req)` from `utils/accessScope.js`** — it returns `null` (caller must 403) when there's no authenticated tenant, `{ tenantId }` for a tenant-scoped role (every branch in the tenant), or `{ tenantId, branchId }` for a branch-scoped role (see `models/Rolemodel.js`'s `scope` field). Never hand-roll a `{ tenantId }`/`{ tenantId, branchId }` filter, never read tenant/branch identity from a request header (`x-tenant-id`/`x-branch-id`), and never fall back to a literal default tenant like `"default-tenant"` — those are exactly the bugs `docs/06-external-integrations/01-tenant-provisioning-fix.md` and `02-tenant-isolation-audit.md` fixed. `tests/accessScopeRegression.test.js` fails the build if any of them are reintroduced. New endpoints touching tenant-owned data must use `getAccessScope(req)` from day one.

### Domain contexts (write ownership)

- **Visa** — case, requirements, documents, workflow (`VisaService`, `VisaWorkflowService`, `VisaRequirementService`, `EnterpriseDocumentService`, `DocumentVerificationService`, `EmbassyProcessingService`, `SchedulingEngineService`, `PassportTrackingEngineService`)
- **Booking/Travel** — booking headers, services, travelers, itineraries, incidents (`BookingSagaManager`, `TravelOrchestrationEngine`)
- **Flights/Hotels** — GDS integration via provider adapters in `services/gds/` (`BaseGdsAdapter` defines the contract; `AmadeusAdapter`/`SabreAdapter` implement it — new providers must implement the same interface)
- **Analytics** — `KPIEngine` + `VisaAnalyticsEngine` write summary collections (`VisaAnalyticsSummaryModel`, etc.) on a cron (`analyticsScheduler.js`, schedules from `ANALYTICS_CRON_SCHEDULE`/`ANALYTICS_NIGHTLY_CRON_SCHEDULE`)
- **Search** — `SearchEngineService` indexes into `SearchIndexModel`; dashboards/search read summary/index collections, never live operational Visa/Booking records directly

Cross-context communication goes through the event bus or explicit service calls — not direct writes to another context's collections.

### Event bus (`utils/eventBus.js`)

`publishEvent(eventName, payload)` stamps `eventId`/`occurredAt`, dispatches listeners via `queueMicrotask` (non-blocking, `Promise.allSettled`), and — when `EVENT_OUTBOX_ENABLED=true` and Mongo is connected — durably persists the event to `DomainEventModel` with a `deliveryStatus` (`queued` → `dispatched`/`dispatch_failed`). `EVENT_BUS_TRANSPORT=memory` is in-process `EventEmitter` only, correct for a single instance; horizontal scaling needs a real broker adapter (Redis Streams/RabbitMQ/Kafka), not implemented yet. Subscribe with `subscribeEvent(eventName, listener)`.

### Config-driven domain values

Enums/defaults that look like they'd be hardcoded (booking types, statuses, workflow transitions, auth token TTLs) are instead read from env vars with JSON-parsed fallbacks — see `utils/bookingConfig.js`, `utils/authConfig.js`, `utils/gdsConfig.js`, `utils/customerConfig.js`, `utils/storageConfig.js`. When adding a new status/enum value, extend the relevant `get*Config()` function (and its env-var JSON override), not a literal array in a controller/service. Joi validation schemas in `middleware/validateRequest.js` pull their `.valid(...)` lists from these same config functions (e.g. `bookingSchemas` is a `Proxy` that rebuilds schemas from `getBookingConfig()` on every access, so config changes take effect without restart-sensitive schema caching bugs).

### Workflow engine (`utils/WorkflowEngine.js`)

Generic state-machine used by both bookings and visa cases: `getWorkflowDefinitionForEntity`, `executeWorkflowTransition`. Transitions come from `bookingConfig().workflowTransitions` plus entity-specific extras (e.g. visa adds `submit`/`review`/`approve`/`reject`). Transitions flagged `approvalRequired` don't apply immediately — they push a `pendingApprovals` entry on the `WorkflowInstanceModel` and return `{ requiresApproval: true }` unless the caller's `userRoles` includes the required role (or `admin`/`superadmin`).

### Caching (`utils/cacheManager.js`)

`CacheManager` picks Redis (if `REDIS_URL` set and reachable) or an in-memory `Map` fallback at `init()` time, transparently, behind one static API (`get`/`set`/`invalidate`/`invalidatePattern`/`getOrCompute`). Never call Redis directly from services — go through `CacheManager` so the memory fallback keeps working when Redis is absent.

### File storage (`utils/fileStorage.js`, `services/FileUploadService.js`)

Backend selected by `FILE_STORAGE_BACKEND` (`local` | `cloudinary` | `s3`); `config/envValidator.js` enforces the required credentials exist for whichever backend is chosen. Don't assume any one backend — new code touching uploads should go through the storage abstraction, not a provider SDK directly.

### Auth

JWT access/refresh tokens (`utils/authTokens.js`, `utils/authConfig.js`), bcrypt password hashing, TOTP/email/SMS MFA (`otplib`), password history/policy enforcement, session + trusted-device tracking, login lockout after N failed attempts — all thresholds configurable via env (see `.env.example`). `authenticateAccessToken` middleware expects `Authorization: Bearer <token>` and sets `req.auth` from the verified JWT payload (`tenantId`, `branchId`, `userId`/`id`, roles, etc.) — that's the source controllers read tenant/branch context from.

### Responses & errors

All controllers respond via `sendSuccess(res, statusCode, message, data, requestId)` / `sendError(res, statusCode, message, requestId, data)` from `utils/apiResponse.js` — keep that envelope (`{ success, message, data, requestId }`) consistent for any new endpoint. `req.requestId` is set per-request by `middleware/requestContext.js` (from `X-Request-ID` header or generated) and echoed back on the response header and in every log line/error payload. Uncaught errors fall through to `middleware/errorHandler.js`, which hides internal error messages in production (`NODE_ENV=production`) but includes them otherwise.

### API docs

`docs/05-api/*.md` documents each route group's request/response shapes (auth, users, customers, bookings, visa + its sub-areas, GDS/flight/hotel distribution, travel). Check the matching doc before changing a route's contract.
