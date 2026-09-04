import jwt from "jsonwebtoken";
import { sendError } from "../utils/apiResponse.js";
import { getAuthConfig } from "../utils/authConfig.js";
import RoleModel from "../models/Rolemodel.js";
import CacheManager from "../utils/cacheManager.js";
import TenantSubscriptionService from "../services/TenantSubscriptionService.js";
import { recordEnforcementCheck } from "../utils/enforcementMetrics.js";

const authConfig = getAuthConfig();

// Access tokens intentionally do not carry a `permissions` claim (role
// assignment can change between token issuances without waiting for a
// re-login), so every request resolves the caller's current permissions
// from their role here — same source (Role.permissions) that
// resolveDomainContext() in Auth.js uses for GET /auth/me. Cached briefly
// since roles rarely change and this now runs on every authenticated request.
//
// Role.name is unique per tenant, not globally (models/Rolemodel.js), so the
// lookup must be tenant-scoped too — otherwise two different tenants' same-
// named roles (e.g. both called "Administrator") would collide and this
// could resolve to the wrong tenant's permission set entirely.
const resolveRolePermissions = async (tenantId, roleName) => {
    if (!roleName || !tenantId) return [];
    const { data } = await CacheManager.getOrCompute(`role:permissions:${tenantId}:${roleName}`, async () => {
        const roleRecord = await RoleModel.findOne({ tenantId, name: roleName, status: "active" }).lean();
        return roleRecord?.permissions || [];
    });
    return data;
};

/** Thrown by resolveAuthFromAccessToken — carries the same (status, message, extra) shape the Express middleware below has always mapped 1:1 onto sendError(), so extracting this logic changes nothing about what a client observes. */
export class AccessTokenError extends Error {
    constructor(status, message, extra = null) {
        super(message);
        this.status = status;
        this.extra = extra;
    }
}

/**
 * The real JWT-verify -> type-check -> subscription-enforcement ->
 * permission-resolution pipeline, extracted so a non-Express entry point
 * (Voice-Based Booking Creation PRD B4.5's Mode B WebSocket handshake — no
 * req/res to run Express middleware against) can share this exact
 * implementation instead of a second, parallel one. Every line below is
 * copied unchanged from the pre-extraction authenticateAccessToken, only
 * reformatted into a plain function — behavior for the Express middleware
 * (which now just calls this) is unchanged.
 *
 * `onBlocked(tenantId, block)` lets each caller record its own
 * blocked-request telemetry with context this function doesn't have
 * (Express's req.method/req.originalUrl vs. a WS session's own
 * descriptor) — still fire-and-forget, never awaited, same "must never add
 * latency to an already-blocked response" discipline as before.
 */
export const resolveAuthFromAccessToken = async (token, { onBlocked } = {}) => {
    if (!token) throw new AccessTokenError(401, "Missing JWT");

    let payload;
    try {
        payload = jwt.verify(token, authConfig.accessTokenSecret);
    } catch (error) {
        if (error.name === "TokenExpiredError") {
            throw new AccessTokenError(401, "Expired JWT");
        }
        throw new AccessTokenError(401, "Invalid JWT");
    }

    if (payload.type !== "access") {
        throw new AccessTokenError(401, "Invalid JWT");
    }

    // Enterprise Subscription Platform — "Auth -> Tenant Exists ->
    // Subscription Active -> Permission -> Execute API." A short-lived
    // access token remains cryptographically valid for its own remaining
    // TTL even after a tenant is suspended (login/refresh already reject
    // a suspended tenant — controllers/Auth.js — but neither of those
    // runs again mid-token-lifetime); this is the one real per-request
    // check that closes that window, cached briefly
    // (TenantSubscriptionService.getEnforcementBlock) so it doesn't add a
    // DB round trip to every request. Returns null (no-op) for any tenant
    // with no TenantSubscriptionModel row at all — every tenant that
    // predates this platform is completely unaffected.
    if (payload.tenantId) {
        // Enterprise Subscription Enforcement Middleware (Automation #6) —
        // "Monitoring Dashboard... Average Middleware Time." Real,
        // in-process timing around the one enforcement check itself, never
        // the whole request — utils/enforcementMetrics.js.
        const enforcementCheckStartedAt = Date.now();
        try {
            const block = await TenantSubscriptionService.getEnforcementBlock(payload.tenantId);
            recordEnforcementCheck(Date.now() - enforcementCheckStartedAt, !!block);
            if (block) {
                // Enterprise Access Revocation Engine (Automation #5) /
                // Enterprise Subscription Enforcement Middleware
                // (Automation #6) — "Monitoring Dashboard... Blocked API
                // Requests" + "Every blocked request MUST be audited."
                if (onBlocked) onBlocked(payload.tenantId, block);
                throw new AccessTokenError(block.httpStatus, block.message, { code: block.code });
            }
        } catch (error) {
            if (error instanceof AccessTokenError) throw error;
            recordEnforcementCheck(Date.now() - enforcementCheckStartedAt, false);
            // Fail OPEN on an enforcement-check error (e.g. a transient DB
            // hiccup) — an availability bug in this platform must never
            // itself become a reason every tenant gets locked out; the
            // same "fail open" discipline middleware/idempotency.js
            // already documents for its own store lookup.
        }
    }

    try {
        payload.permissions = await resolveRolePermissions(payload.tenantId, payload.role);
    } catch (error) {
        throw new AccessTokenError(500, "Unable to resolve permissions");
    }

    return payload;
};

const authenticateAccessToken = async (req, res, next) => {
    const requestId = req.requestId || req.header("X-Request-ID") || null;
    const authorization = req.header("Authorization");

    if (!authorization || !authorization.startsWith("Bearer ")) {
        return sendError(res, 401, "Missing JWT", requestId);
    }

    const token = authorization.slice(7).trim();

    try {
        req.auth = await resolveAuthFromAccessToken(token, {
            onBlocked: (tenantId, block) => {
                // Real, fire-and-forget (never awaited — must never add
                // latency to an already-blocked response).
                TenantSubscriptionService.recordBlockedRequest(tenantId, { endpoint: `${req.method} ${req.originalUrl}`, code: block.code });
            }
        });
        req.accessToken = token;
    } catch (error) {
        if (error instanceof AccessTokenError) {
            return sendError(res, error.status, error.message, requestId, error.extra || undefined);
        }
        throw error;
    }

    next();
};

export default authenticateAccessToken;