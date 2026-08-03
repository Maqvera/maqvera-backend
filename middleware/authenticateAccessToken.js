import jwt from "jsonwebtoken";
import { sendError } from "../utils/apiResponse.js";
import { getAuthConfig } from "../utils/authConfig.js";
import RoleModel from "../models/Rolemodel.js";
import CacheManager from "../utils/cacheManager.js";

const authConfig = getAuthConfig();

// Access tokens intentionally do not carry a `permissions` claim (role
// assignment can change between token issuances without waiting for a
// re-login), so every request resolves the caller's current permissions
// from their role here — same source (Role.permissions) that
// resolveDomainContext() in Auth.js uses for GET /auth/me. Cached briefly
// since roles rarely change and this now runs on every authenticated request.
const resolveRolePermissions = async (roleName) => {
    if (!roleName) return [];
    const { data } = await CacheManager.getOrCompute(`role:permissions:${roleName}`, async () => {
        const roleRecord = await RoleModel.findOne({ name: roleName, status: "active" }).lean();
        return roleRecord?.permissions || [];
    });
    return data;
};

const authenticateAccessToken = async (req, res, next) => {
    const requestId = req.requestId || req.header("X-Request-ID") || null;
    const authorization = req.header("Authorization");

    if (!authorization || !authorization.startsWith("Bearer ")) {
        return sendError(res, 401, "Missing JWT", requestId);
    }

    const token = authorization.slice(7).trim();

    let payload;
    try {
        payload = jwt.verify(token, authConfig.accessTokenSecret);
    } catch (error) {
        if (error.name === "TokenExpiredError") {
            return sendError(res, 401, "Expired JWT", requestId);
        }
        return sendError(res, 401, "Invalid JWT", requestId);
    }

    if (payload.type !== "access") {
        return sendError(res, 401, "Invalid JWT", requestId);
    }

    req.auth = payload;
    req.accessToken = token;

    try {
        req.auth.permissions = await resolveRolePermissions(payload.role);
    } catch (error) {
        return sendError(res, 500, "Unable to resolve permissions", requestId);
    }

    next();
};

export default authenticateAccessToken;