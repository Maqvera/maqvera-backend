import TenantProfileModel from "../models/TenantProfileModel.js";

// Per-Tenant Domain-Masked Landing Page (PRD v2 §2.2) — resolves tenant
// identity from the request's own `Host` header for the one public,
// pre-login surface that needs it. Deliberately NOT getAccessScope/
// utils/accessScope.js: that helper is the tenant-isolation boundary for
// the entire AUTHENTICATED API and reads req.auth (a verified JWT) — this
// middleware has no JWT to read from (there's no login yet) and sets a
// completely separate field, `req.resolvedTenantId`, on a completely
// separate, always-public route. Mounted ONLY on
// routes/PublicLandingPageRoutes.js — never on any authenticated route.
//
// Same "never trust a client-supplied identifier" discipline as
// getAccessScope, just resolved from a different real signal: the visitor's
// browser sends the Host header, never a tenantId/slug the visitor could
// forge in a query string or body to view another tenant's landing page
// (this route is read-only/public anyway, but the principle holds — the
// resolution logic should never take a shortcut a future write endpoint
// might accidentally copy).
// Read fresh on every call, not frozen at module-load time — same "config
// re-read dynamically, never restart-sensitive" discipline this codebase's
// other getXConfig() helpers already follow (see CLAUDE.md), and it's what
// makes this function testable via a per-test env override.
const getRootDomain = () => (process.env.PLATFORM_ROOT_DOMAIN || "maqvera.com").toLowerCase();

const extractSubdomain = (hostname) => {
  const rootDomain = getRootDomain();
  const host = hostname.toLowerCase();
  if (host === rootDomain || host === `www.${rootDomain}`) return null;
  if (!host.endsWith(`.${rootDomain}`)) return null;
  const subdomain = host.slice(0, -(`.${rootDomain}`.length));
  // A dot in what's left means a deeper label than one subdomain segment
  // (e.g. "a.b.maqvera.com") — not a shape this feature resolves.
  if (!subdomain || subdomain.includes(".")) return null;
  return subdomain;
};

const resolveTenantByHost = async (req, res, next) => {
  try {
    const hostHeader = req.headers.host || "";
    const hostname = hostHeader.split(":")[0].trim().toLowerCase();

    if (!hostname) {
      req.resolvedTenantId = null;
      req.resolvedTenantSlug = null;
      return next();
    }

    const subdomain = extractSubdomain(hostname);
    let profile = null;

    if (subdomain) {
      profile = await TenantProfileModel.findOne({ publicSlug: subdomain }).select("tenantId publicSlug").lean();
    } else {
      // Not a *.{rootDomain} request — only remaining possibility is a
      // verified Tier 2 custom domain (PRD v2 §2.5). An unverified/pending
      // customDomain must never resolve — that's the whole point of the
      // verification step.
      profile = await TenantProfileModel.findOne({ customDomain: hostname, customDomainStatus: "verified" }).select("tenantId publicSlug").lean();
    }

    req.resolvedTenantId = profile ? profile.tenantId : null;
    req.resolvedTenantSlug = profile ? profile.publicSlug : null;
    next();
  } catch (error) {
    console.error("resolveTenantByHost error:", error);
    // Fail open to "unresolved," never a 500 — an availability bug in this
    // lookup must never take down the one surface a prospective customer
    // sees before ever logging in (same discipline as
    // middleware/subscriptionEnforcement.js's own fail-open comment).
    req.resolvedTenantId = null;
    req.resolvedTenantSlug = null;
    next();
  }
};

export default resolveTenantByHost;
