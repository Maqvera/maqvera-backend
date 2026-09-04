# Per-Tenant Domain-Masked Landing Page

PRD v2 "Per-Tenant Domain-Masked Landing Page." A single wildcard-DNS-backed route (`GET /`, no `/api/v1` prefix) serves every tenant's marketing landing page from one deployment — the visitor's `Host` header, never a path/query parameter, decides which tenant's data renders. Every tenant, same fixed 15-section design; only text/business data varies.

## Tenant resolution — `middleware/resolveTenantByHost.js`

Mounted **only** on `routes/PublicLandingPageRoutes.js`, never on any authenticated route. Deliberately separate from `getAccessScope(req)` (`utils/accessScope.js`) — that's the tenant-isolation boundary for the whole authenticated API and reads a verified JWT; this middleware has no JWT to read (pre-login) and sets a different field, `req.resolvedTenantId` / `req.resolvedTenantSlug`, never `req.auth`.

- **Subdomain** — `{slug}.{PLATFORM_ROOT_DOMAIN}` (env var, default `maqvera.com`) resolves via `TenantProfileModel.publicSlug`.
- **Custom domain** (Tier 2) — an exact `Host` match against `TenantProfileModel.customDomain`, **only when `customDomainStatus === "verified"`** — a `pending_dns`/`failed`/`unset` domain never resolves a tenant.
- Unknown host, missing profile, or any lookup error → `req.resolvedTenantId = null` and the middleware still calls `next()` (fails open — an availability bug here must never take down the one page a prospective customer sees before ever logging in). The controller renders a friendly "not configured" HTML page (404), never a JSON error.

## Data model additions (`models/TenantProfileModel.js`, all additive)

Reuses the `publicSlug` (Public B2C Booking Site) and `customDomain` (White-Label) fields that already existed on this model from earlier work — **does not** introduce a second, nested `domainSettings.{slug,customDomain}` object, to avoid two sources of truth for the same tenant identifier. Only the genuinely new fields were added:

- `customDomainStatus` (`unset`/`pending_dns`/`verified`/`failed`, default `unset`)
- `customDomainVerificationToken` (default `null`) — reserved for Tier 2 (Cloudflare for SaaS), not yet wired to anything
- `sslStatus` (`not_applicable`/`pending`/`active`/`failed`, default `not_applicable`) — same, reserved for Tier 2
- `documentSettings.aboutText` (default `null`) — the landing page's "About the agency" section; every existing invoice/voucher/receipt template is unaffected (none of them reference this new key)
- `socialLinks.{facebook,instagram,twitter,linkedin,youtube,tiktok}` (all default `null`)

`publicSlug` and `customDomain` are now **sticky** on `PUT /tenant-profile` (`controllers/TenantProfileController.js`) — omitting them from a save request preserves the existing stored value instead of the full-replace-style wipe every other field on that endpoint uses; an explicit `null`/`""` still clears them. `publicSlug` auto-generates from `companyName` (via the new `utils/slugify.js`) the first time a profile is created with no slug already set, with a numeric-suffix collision fallback (`-2`, `-3`, ...) — it is never regenerated on a later update.

## `GET /` (public, unauthenticated, rate-limited)

`routes/PublicLandingPageRoutes.js` → `controllers/PublicLandingPageController.js` → `services/PublicLandingPageService.js` builds the view model:

- **Company/branding/contact** straight from `TenantProfileModel`.
- **Featured packages** — reuses `PublicBookingService.listPublicPackages` (the same public-catalog resolution the B2C booking site already uses: `PackageTemplateModel` rows with `publicVisible: true`), **not** raw `PackageModel` — a `PackageModel` entry is one specific customer's private calculated quote, never appropriate to show a stranger.
- **Hotels** — up to 3 from `HotelCatalogModel`, sorted by star rating.
- **Testimonials** — up to 6 `ReviewModel` rows with `status: "published"` only; a `pending`/`hidden` review never appears.
- **Contact form** — posts client-side (`fetch`) to the existing `POST /api/v1/public/leads` (already built) with the resolved tenant's slug in a hidden field; no new send logic.

`services/LandingPageRenderService.js` compiles `templates/landingPage/index.html` (Handlebars, same engine as every invoice/voucher template) to an HTML string and serves it directly — deliberately **not** routed through `services/HtmlPdfRenderer.js` (that always launches headless Chromium and returns a PDF/image Buffer, the wrong shape for a live web response); its own compiled-template cache and Puppeteer singleton are untouched.

## What's explicitly deferred

- **Tier 2 (custom domain / Cloudflare for SaaS)** — the model fields (`customDomainStatus`, `customDomainVerificationToken`, `sslStatus`) and the resolution middleware's verified-custom-domain branch are ready, but `services/CloudflareCustomHostnameService.js` and the `POST/GET/DELETE /tenant-profile/domain` endpoints are **not built** — needs Cloudflare for SaaS availability confirmed on the account first (a scope/billing question, not a coding blocker).
- Per-tenant theme override, hero/gallery image upload, section reordering, and a blog/CMS engine are explicitly out of scope per the PRD.
