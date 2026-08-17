import { getApiVersionStatus } from "../utils/apiVersioning.js";
import { AppError, sendStandardError } from "../utils/errorContract.js";

/**
 * Enterprise API Version Strategy Standard (Enterprise Architecture
 * Hardening Phase, Improvement 8). Opt-in, per-route-group middleware:
 * `router.use(apiVersionLifecycle("Payments", "v1"))`. Not mounted on any
 * existing route in this pass — see docs/07-enterprise-standards/
 * 08-api-version-strategy.md "Adoption". An API/version that was never
 * registered is a real, valid, unregistered state — this middleware is a
 * silent no-op for it, never inventing a fake GA record just to have
 * something to check.
 *
 * - **Sunset / Retired** — the real support window has ended; the request
 *   is rejected outright (`410 API_VERSION_UNAVAILABLE`), not just
 *   logged.
 * - **Deprecated** — "Server returns Deprecation: true, Sunset: <date>,
 *   Latest-Version: v2" — real response headers, request still proceeds
 *   (still inside its published support period).
 * - Everything else (Design/Preview/Beta/GA) — no headers, normal
 *   pass-through.
 */
export const apiVersionLifecycle = (apiName, version) => async (req, res, next) => {
  let entry;
  try {
    entry = await getApiVersionStatus(apiName, version);
  } catch (error) {
    // Fail open — a registry-lookup hiccup must never block real traffic,
    // same discipline as middleware/idempotency.js's own documented
    // fail-open behavior.
    return next();
  }
  if (!entry) return next();

  if (entry.status === "Sunset" || entry.status === "Retired") {
    return sendStandardError(res, new AppError("API_VERSION_UNAVAILABLE", { details: { apiName, version, status: entry.status, latestVersion: entry.latestVersion || undefined } }), req.requestId);
  }

  if (entry.status === "Deprecated") {
    res.setHeader("Deprecation", "true");
    if (entry.sunsetAt) res.setHeader("Sunset", new Date(entry.sunsetAt).toUTCString());
    if (entry.latestVersion) res.setHeader("Latest-Version", entry.latestVersion);
  }

  next();
};

export default apiVersionLifecycle;
