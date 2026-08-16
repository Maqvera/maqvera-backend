import CustomerPortalService from "../services/CustomerPortalService.js";
import { sendSuccess, sendError } from "../utils/apiResponse.js";
import { createRequestId } from "../utils/authTokens.js";
import { getAccessScope } from "../utils/accessScope.js";

const hasPermission = (req, ...keys) => {
  const permissions = req.auth?.permissions || [];
  return permissions.includes("admin") || keys.some((key) => permissions.includes(key));
};

const statusFromError = (error) => {
  const message = error.message || "";
  if (message.includes("not found")) return 404;
  if (message.includes("expired")) return 410;
  return 500;
};

export const generateCustomerPortalToken = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.customercollection.manage")) return sendError(res, 403, "Permission denied.", requestId);
    const userId = req.auth?.userId || req.auth?.id || null;

    const result = await CustomerPortalService.generatePortalToken(req.params.customerId, scope.tenantId, userId);
    return sendSuccess(res, 201, "Customer portal link generated successfully.", result, requestId);
  } catch (error) {
    console.error("generateCustomerPortalToken error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to generate customer portal link.", requestId);
  }
};

/** Public — resolved by the unguessable token, registered before router.use(authenticateAccessToken). GET-only by design — see CustomerPortalService's own doc comment. */
export const viewCustomerPortalByToken = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const result = await CustomerPortalService.getPortalDataByToken(req.params.token);
    return sendSuccess(res, 200, "Customer portal data retrieved successfully.", result, requestId);
  } catch (error) {
    console.error("viewCustomerPortalByToken error:", error);
    return sendError(res, statusFromError(error), error.message || "Customer portal link not found.", requestId);
  }
};
