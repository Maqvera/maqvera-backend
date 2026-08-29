import EmbassyMasterModel from "../models/EmbassyMasterModel.js";
import { sendSuccess, sendError } from "../utils/apiResponse.js";
import { createRequestId } from "../utils/authTokens.js";
import { getAccessScope } from "../utils/accessScope.js";

const hasPermission = (req, ...keys) => {
  const permissions = req.auth?.permissions || [];
  return permissions.includes("admin") || keys.some((key) => permissions.includes(key));
};

/**
 * PRD "CRM Feature Map by Phase" Phase 4 module 40 (Emergency Support) —
 * the one missing piece next to the already-solid
 * models/TravelIncidentManagementModel.js/TravelIncidentController.js:
 * an embassy/consulate contact directory. No controller existed for
 * models/EmbassyMasterModel.js at all before this (it was populated only
 * via direct seeding for visa-submission routing) — this is a small,
 * genuinely new CRUD surface, not an extension of an existing one.
 */
export const listEmbassyContacts = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "reference.read", "reference.manage")) return sendError(res, 403, "Permission denied.", requestId);

    const filter = { tenantId: scope.tenantId };
    if (req.query.countryId) filter.countryId = req.query.countryId;
    if (req.query.isActive !== undefined) filter.isActive = req.query.isActive === "true";

    const items = await EmbassyMasterModel.find(filter).select("-__v").sort({ countryId: 1, name: 1 }).lean();
    return sendSuccess(res, 200, "Embassy contacts retrieved successfully.", { items }, requestId);
  } catch (error) {
    console.error("listEmbassyContacts error:", error);
    return sendError(res, 500, error.message || "Failed to retrieve embassy contacts.", requestId);
  }
};

export const createEmbassyContact = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "reference.manage")) return sendError(res, 403, "Permission denied.", requestId);

    const { embassyId, name, processingCenterType, countryId, city = null, phone = null, email = null, address = null, emergencyContactPhone = null } = req.body;
    if (!embassyId || !name || !processingCenterType || !countryId) {
      return sendError(res, 400, "embassyId, name, processingCenterType, and countryId are required.", requestId);
    }

    const existing = await EmbassyMasterModel.findOne({ tenantId: scope.tenantId, embassyId });
    if (existing) return sendError(res, 409, `An embassy contact with embassyId "${embassyId}" already exists.`, requestId);

    const embassy = await EmbassyMasterModel.create({
      tenantId: scope.tenantId, embassyId, name, processingCenterType, countryId, city, phone, email, address, emergencyContactPhone
    });

    return sendSuccess(res, 201, "Embassy contact created successfully.", embassy.toJSON(), requestId);
  } catch (error) {
    console.error("createEmbassyContact error:", error);
    return sendError(res, 500, error.message || "Failed to create embassy contact.", requestId);
  }
};

export const updateEmbassyContact = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "reference.manage")) return sendError(res, 403, "Permission denied.", requestId);

    const embassy = await EmbassyMasterModel.findOne({ _id: req.params.embassyId, tenantId: scope.tenantId });
    if (!embassy) return sendError(res, 404, "Embassy contact not found.", requestId);

    const { name, processingCenterType, city, phone, email, address, emergencyContactPhone, isActive } = req.body;
    if (name !== undefined) embassy.name = name;
    if (processingCenterType !== undefined) embassy.processingCenterType = processingCenterType;
    if (city !== undefined) embassy.city = city;
    if (phone !== undefined) embassy.phone = phone;
    if (email !== undefined) embassy.email = email;
    if (address !== undefined) embassy.address = address;
    if (emergencyContactPhone !== undefined) embassy.emergencyContactPhone = emergencyContactPhone;
    if (isActive !== undefined) embassy.isActive = isActive;
    await embassy.save();

    return sendSuccess(res, 200, "Embassy contact updated successfully.", embassy.toJSON(), requestId);
  } catch (error) {
    console.error("updateEmbassyContact error:", error);
    return sendError(res, 500, error.message || "Failed to update embassy contact.", requestId);
  }
};
