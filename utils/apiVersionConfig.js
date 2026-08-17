import dotenv from "dotenv";

dotenv.config();

const parseJson = (value, fallback) => {
  if (!value) return fallback;
  if (typeof value === "string") {
    try {
      return JSON.parse(value);
    } catch (error) {
      return fallback;
    }
  }
  return value;
};

const parseStringList = (value, fallback) => {
  const parsed = parseJson(value, fallback);
  if (!Array.isArray(parsed)) return fallback;
  return parsed.map((item) => `${item}`.trim()).filter(Boolean);
};

// Enterprise Architecture Hardening Phase — API Version Strategy Standard
// (Improvement 8). URL versioning (`/api/v1/...`) is already this
// codebase's real, already-implemented strategy — every route in
// server.js is already mounted this way. The real gap this standard
// closes is the missing LIFECYCLE around that: a registry, deprecation
// response headers, and a published support-window policy — not
// inventing a second versioning scheme.
export const getApiVersionConfig = () => {
  return {
    // "Design -> Preview -> Beta -> General Availability (GA) ->
    // Deprecated -> Sunset -> Retired."
    lifecycleStatuses: parseStringList(process.env.API_VERSION_LIFECYCLE_STATUSES_JSON, ["Design", "Preview", "Beta", "GA", "Deprecated", "Sunset", "Retired"]),
    // "Minimum Support Policy — GA Version Support 36 Months, Deprecated
    // Version Support 12 Months." Used as the real default `supportedUntil`
    // when a caller deprecates a version without specifying one.
    gaSupportMonths: parseInt(process.env.API_VERSION_GA_SUPPORT_MONTHS || "36", 10),
    deprecatedSupportMonths: parseInt(process.env.API_VERSION_DEPRECATED_SUPPORT_MONTHS || "12", 10),
    // How long `middleware/apiVersionLifecycle.js` caches a registry
    // lookup (via utils/cacheManager.js) before re-reading Mongo — a
    // status change should be visible within this window, not instantly
    // required (lifecycle transitions are rare, planned events).
    cacheTtlSeconds: parseInt(process.env.API_VERSION_CACHE_TTL_SECONDS || "60", 10),
    defaultPageSize: parseInt(process.env.API_VERSION_DEFAULT_PAGE_SIZE || "20", 10),
    maxPageSize: parseInt(process.env.API_VERSION_MAX_PAGE_SIZE || "100", 10)
  };
};

export default getApiVersionConfig;
