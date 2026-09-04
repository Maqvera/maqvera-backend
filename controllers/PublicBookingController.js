import PublicBookingService from "../services/PublicBookingService.js";
import { sendSuccess, sendError } from "../utils/apiResponse.js";
import { createRequestId } from "../utils/authTokens.js";

// Public B2C Booking Site (PRD "CRM Feature Map by Phase" Phase 2 module
// 15) — the one genuinely public, unauthenticated controller in this
// codebase apart from webhook/OAuth-callback endpoints (see
// routes/PublicBookingRoutes.js's own doc comment). No getAccessScope/
// req.auth anywhere here on purpose: tenant identity comes from a
// `tenantSlug` the service resolves against TenantProfileModel.publicSlug.
const statusFromError = (error) => {
  const message = error.message || "";
  if (message.includes("not found")) return 404;
  if (message.includes("already in use")) return 409;
  if (message.includes("required") || message.includes("cannot") || message.includes("not currently available")) return 400;
  return 500;
};

export const GetPublicPackages = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const result = await PublicBookingService.listPublicPackages(req.query.tenantSlug, req.query);
    return sendSuccess(res, 200, "Packages retrieved successfully.", result, requestId);
  } catch (error) {
    console.error("GetPublicPackages error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to retrieve packages.", requestId);
  }
};

export const GetPublicPackageDetail = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const result = await PublicBookingService.getPublicPackageDetail(req.query.tenantSlug, req.params.id);
    return sendSuccess(res, 200, "Package retrieved successfully.", result, requestId);
  } catch (error) {
    console.error("GetPublicPackageDetail error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to retrieve package.", requestId);
  }
};

export const CreatePublicBooking = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const result = await PublicBookingService.createPublicBooking(req.body?.tenantSlug, req.body, requestId);
    return sendSuccess(res, 201, "Booking created successfully.", result, requestId);
  } catch (error) {
    console.error("CreatePublicBooking error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to create booking.", requestId);
  }
};

export const CreatePublicLead = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const lead = await PublicBookingService.createPublicLead(req.body?.tenantSlug, req.body);
    return sendSuccess(res, 201, "Thanks — we'll be in touch shortly.", lead, requestId);
  } catch (error) {
    console.error("CreatePublicLead error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to submit request.", requestId);
  }
};
