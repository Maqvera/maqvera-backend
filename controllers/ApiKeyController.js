import crypto from "crypto";
import ApiKeyModel from "../models/ApiKeyModel.js";
import AuditLogModel from "../models/AuditLogmodel.js";
import { hashToken } from "../utils/authTokens.js";
import { sendSuccess, sendError } from "../utils/apiResponse.js";
import { createRequestId } from "../utils/authTokens.js";
import { getAccessScope } from "../utils/accessScope.js";
import { publishEvent } from "../utils/eventBus.js";

const hasPermission = (req, ...keys) => {
  const permissions = req.auth?.permissions || [];
  return permissions.includes("admin") || keys.some((key) => permissions.includes(key));
};

const generateRawKey = () => `mvk_${crypto.randomBytes(24).toString("hex")}`;

export const createApiKey = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "apikey.manage")) return sendError(res, 403, "Permission denied.", requestId);

    const { name, permissions = [], expiresAt = null } = req.body;
    if (!name) return sendError(res, 400, "name is required.", requestId);

    const callerPermissions = req.auth?.permissions || [];
    const isAdmin = callerPermissions.includes("admin");
    const invalidPermissions = isAdmin ? [] : permissions.filter((p) => !callerPermissions.includes(p));
    if (invalidPermissions.length > 0) {
      return sendError(res, 400, `Cannot grant a key permissions you don't hold yourself: ${invalidPermissions.join(", ")}.`, requestId);
    }

    const rawKey = generateRawKey();
    const apiKey = await ApiKeyModel.create({
      tenantId: scope.tenantId,
      name,
      keyPrefix: rawKey.slice(0, 12),
      hashedKey: hashToken(rawKey),
      permissions: isAdmin ? permissions : permissions.filter((p) => callerPermissions.includes(p)),
      expiresAt: expiresAt ? new Date(expiresAt) : null,
      createdBy: req.auth?.id || req.auth?.userId || null
    });

    await AuditLogModel.create({ action: "apikey.create", module: "ApiKey", resource: "ApiKey", resourceId: apiKey._id.toString(), userId: req.auth?.id || null, tenantId: scope.tenantId, details: { name, keyPrefix: apiKey.keyPrefix } });
    publishEvent("ApiKeyCreated", { tenantId: scope.tenantId, apiKeyId: apiKey._id.toString(), performedBy: req.auth?.id || null });

    // The ONLY time the raw key is ever returned — never again after this response.
    return sendSuccess(res, 201, "API key created successfully. This key will not be shown again — store it securely.", { ...apiKey.toJSON(), key: rawKey }, requestId);
  } catch (error) {
    console.error("createApiKey error:", error);
    return sendError(res, 500, error.message || "Failed to create API key.", requestId);
  }
};

export const listApiKeys = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "apikey.manage")) return sendError(res, 403, "Permission denied.", requestId);

    const items = await ApiKeyModel.find({ tenantId: scope.tenantId }).select("-hashedKey").sort({ createdAt: -1 }).lean();
    return sendSuccess(res, 200, "API keys retrieved successfully.", { items }, requestId);
  } catch (error) {
    console.error("listApiKeys error:", error);
    return sendError(res, 500, error.message || "Failed to retrieve API keys.", requestId);
  }
};

export const revokeApiKey = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "apikey.manage")) return sendError(res, 403, "Permission denied.", requestId);

    const apiKey = await ApiKeyModel.findOne({ _id: req.params.apiKeyId, tenantId: scope.tenantId });
    if (!apiKey) return sendError(res, 404, "API key not found.", requestId);
    if (apiKey.status === "Revoked") return sendError(res, 409, "API key is already revoked.", requestId);

    apiKey.status = "Revoked";
    apiKey.revokedBy = req.auth?.id || req.auth?.userId || null;
    apiKey.revokedAt = new Date();
    await apiKey.save();

    await AuditLogModel.create({ action: "apikey.revoke", module: "ApiKey", resource: "ApiKey", resourceId: apiKey._id.toString(), userId: req.auth?.id || null, tenantId: scope.tenantId, details: {} });
    publishEvent("ApiKeyRevoked", { tenantId: scope.tenantId, apiKeyId: apiKey._id.toString(), performedBy: req.auth?.id || null });

    return sendSuccess(res, 200, "API key revoked successfully.", apiKey.toJSON(), requestId);
  } catch (error) {
    console.error("revokeApiKey error:", error);
    return sendError(res, 500, error.message || "Failed to revoke API key.", requestId);
  }
};
