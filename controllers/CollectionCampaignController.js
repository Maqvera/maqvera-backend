import CollectionCampaignService from "../services/CollectionCampaignService.js";
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
  if (message.includes("required") || message.includes("Invalid") || message.includes("Cannot") || message.includes("Only a Draft")) return 400;
  return 500;
};

export const createCampaign = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.collectioncampaign.manage")) return sendError(res, 403, "Permission denied.", requestId);
    const userId = req.auth?.userId || req.auth?.id || null;

    const campaign = await CollectionCampaignService.createCampaign(req.body, scope.tenantId, userId);
    return sendSuccess(res, 201, "Collection campaign created successfully.", campaign, requestId);
  } catch (error) {
    console.error("createCampaign error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to create collection campaign.", requestId);
  }
};

export const listCampaigns = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.collectioncampaign.read", "finance.read")) return sendError(res, 403, "Permission denied.", requestId);

    const items = await CollectionCampaignService.listCampaigns(req.query, scope.tenantId);
    return sendSuccess(res, 200, "Collection campaigns retrieved successfully.", { items }, requestId);
  } catch (error) {
    console.error("listCampaigns error:", error);
    return sendError(res, 500, error.message || "Failed to retrieve collection campaigns.", requestId);
  }
};

export const getCampaign = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.collectioncampaign.read", "finance.read")) return sendError(res, 403, "Permission denied.", requestId);

    const campaign = await CollectionCampaignService.getCampaignById(req.params.campaignId, scope.tenantId);
    return sendSuccess(res, 200, "Collection campaign retrieved successfully.", campaign, requestId);
  } catch (error) {
    console.error("getCampaign error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to retrieve collection campaign.", requestId);
  }
};

export const previewCampaignTargets = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.collectioncampaign.read", "finance.read")) return sendError(res, 403, "Permission denied.", requestId);

    const preview = await CollectionCampaignService.previewTargets(req.params.campaignId, scope.tenantId);
    return sendSuccess(res, 200, "Collection campaign target preview generated.", preview, requestId);
  } catch (error) {
    console.error("previewCampaignTargets error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to preview collection campaign targets.", requestId);
  }
};

export const runCampaign = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.collectioncampaign.manage")) return sendError(res, 403, "Permission denied.", requestId);
    const userId = req.auth?.userId || req.auth?.id || null;

    const campaign = await CollectionCampaignService.runCampaign(req.params.campaignId, scope.tenantId, userId);
    return sendSuccess(res, 200, "Collection campaign run completed.", campaign, requestId);
  } catch (error) {
    console.error("runCampaign error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to run collection campaign.", requestId);
  }
};

export const cancelCampaign = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.collectioncampaign.manage")) return sendError(res, 403, "Permission denied.", requestId);
    const userId = req.auth?.userId || req.auth?.id || null;

    const campaign = await CollectionCampaignService.cancelCampaign(req.params.campaignId, scope.tenantId, userId);
    return sendSuccess(res, 200, "Collection campaign cancelled successfully.", campaign, requestId);
  } catch (error) {
    console.error("cancelCampaign error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to cancel collection campaign.", requestId);
  }
};
