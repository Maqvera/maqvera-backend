import VendorPortalTokenModel from "../models/VendorPortalTokenModel.js";
import { hashToken } from "../utils/authTokens.js";
import { sendError } from "../utils/apiResponse.js";

// Supplier Self-Service Portal (PRD "CRM Feature Map by Phase" Phase 3
// module 24) — same "own token type, own req field, own narrower scope"
// discipline as middleware/authenticateAgentToken.js (see
// utils/accessScope.js's getAgentAccessScope doc comment): a supplier's
// portal token sets req.vendorAuth (never req.auth), and every
// supplier-portal controller must scope every query to
// {tenantId, vendorId} together, never one alone.
const authenticateVendorPortalToken = async (req, res, next) => {
  try {
    const rawToken = req.header("X-Supplier-Token");
    if (!rawToken) return sendError(res, 401, "A supplier portal token is required.", req.requestId);

    const record = await VendorPortalTokenModel.findOne({ hashedKey: hashToken(rawToken) });
    if (!record || record.status !== "Active") return sendError(res, 401, "Invalid or revoked supplier portal token.", req.requestId);
    if (record.expiresAt && record.expiresAt < new Date()) return sendError(res, 401, "This supplier portal token has expired.", req.requestId);

    record.lastUsedAt = new Date();
    await record.save();

    req.vendorAuth = { tenantId: record.tenantId, vendorId: record.vendorId.toString() };
    next();
  } catch (error) {
    console.error("authenticateVendorPortalToken error:", error);
    return sendError(res, 500, "Unable to authenticate supplier portal token.", req.requestId);
  }
};

export default authenticateVendorPortalToken;
