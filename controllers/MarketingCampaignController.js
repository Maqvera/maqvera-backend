import MarketingCampaignService from "../services/MarketingCampaignService.js";
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
  if (message.includes("required") || message.includes("Invalid") || message.includes("cannot")) return 400;
  return 500;
};

const userIdFrom = (req) => req.auth?.userId || req.auth?.id || null;

export const CreateCampaign = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "campaign.create", "campaign.manage")) return sendError(res, 403, "Permission denied.", requestId);

    const campaign = await MarketingCampaignService.createCampaign(req.body, scope.tenantId, userIdFrom(req));
    return sendSuccess(res, 201, "Campaign created successfully.", campaign, requestId);
  } catch (error) {
    console.error("CreateCampaign error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to create campaign.", requestId);
  }
};

export const ListCampaigns = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "campaign.read", "campaign.manage")) return sendError(res, 403, "Permission denied.", requestId);

    const items = await MarketingCampaignService.listCampaigns(req.query, scope.tenantId);
    return sendSuccess(res, 200, "Campaigns retrieved successfully.", { items }, requestId);
  } catch (error) {
    console.error("ListCampaigns error:", error);
    return sendError(res, 500, error.message || "Failed to retrieve campaigns.", requestId);
  }
};

export const GetCampaign = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "campaign.read", "campaign.manage")) return sendError(res, 403, "Permission denied.", requestId);

    const campaign = await MarketingCampaignService.getCampaignById(req.params.campaignId, scope.tenantId);
    return sendSuccess(res, 200, "Campaign retrieved successfully.", campaign, requestId);
  } catch (error) {
    console.error("GetCampaign error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to retrieve campaign.", requestId);
  }
};

export const SendCampaign = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "campaign.manage")) return sendError(res, 403, "Permission denied.", requestId);

    const campaign = await MarketingCampaignService.sendCampaign(req.params.campaignId, scope.tenantId, userIdFrom(req));
    return sendSuccess(res, 200, "Campaign sent successfully.", campaign, requestId);
  } catch (error) {
    console.error("SendCampaign error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to send campaign.", requestId);
  }
};

export const GetCampaignAnalytics = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "campaign.read", "campaign.manage")) return sendError(res, 403, "Permission denied.", requestId);

    const analytics = await MarketingCampaignService.getCampaignAnalytics(req.params.campaignId, scope.tenantId);
    return sendSuccess(res, 200, "Campaign analytics retrieved successfully.", analytics, requestId);
  } catch (error) {
    console.error("GetCampaignAnalytics error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to retrieve campaign analytics.", requestId);
  }
};
