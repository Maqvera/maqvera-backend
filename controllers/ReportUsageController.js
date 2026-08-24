import ReportUsageAnalyticsService from "../services/ReportUsageAnalyticsService.js";
import { sendError, sendSuccess } from "../utils/apiResponse.js";
import { getAccessScope } from "../utils/accessScope.js";
import { createRequestId } from "../utils/authTokens.js";

/**
 * Reporting Platform Part 12 fix — read-only usage-summary endpoint
 * (ReportUsageSummaryModel, populated by services/ReportUsageAnalyticsService.js
 * off the event bus). Same layering/response-envelope convention as
 * ReportCatalogController.js. Requires "reporting.read".
 */

const getScope = (req) => {
  const accessScope = getAccessScope(req);
  return {
    tenantId: accessScope?.tenantId || null,
    permissions: req.auth?.permissions || []
  };
};

const canRead = (permissions) => permissions.includes("reporting.read") || permissions.includes("admin");

export const getReportUsageSummary = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const { tenantId, permissions } = getScope(req);
    if (!tenantId) return sendError(res, 403, "Tenant context required.", requestId);
    if (!canRead(permissions)) return sendError(res, 403, "Permission denied.", requestId);

    const { module, resourceType, reportKey, days } = req.query;
    const summary = await ReportUsageAnalyticsService.getUsageSummary({
      tenantId, module, resourceType, reportKey, days: days ? Number(days) : undefined
    });
    return sendSuccess(res, 200, "Report usage summary retrieved successfully.", summary, requestId);
  } catch (err) {
    const status = /required/i.test(err.message || "") ? 400 : 500;
    return sendError(res, status, err.message, requestId);
  }
};
