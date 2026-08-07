import SearchEngineService from "../services/SearchEngineService.js";
import { sendError, sendSuccess } from "../utils/apiResponse.js";
import { createRequestId } from "../utils/authTokens.js";
import { publishEvent } from "../utils/eventBus.js";
import { getAccessScope } from "../utils/accessScope.js";

// Branch-scoped roles (models/Rolemodel.js scope: "branch") are always
// locked to their own branch, regardless of ?branchId= — previously only the
// literal "all" was blocked, so a branch-scoped caller could still request a
// DIFFERENT specific branch's search results/suggestions by name.
const resolveSearchBranch = (scope, requestedBranchId) => scope.branchId || requestedBranchId || "all";

/**
 * 1. GET /api/v1/search
 * Performs global search across all authorized ERP entities.
 */
export const GlobalSearch = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    const userId = req.auth?.userId || req.auth?.id;

    if (!scope) {
      return sendError(res, 403, "Tenant context is required.", requestId);
    }
    const tenantId = scope.tenantId;

    const {
      q = "",
      page = "1",
      pageSize = "20",
      entityType,
      branchId,
      sort = "score",
      order = "desc",
      country, embassy, visaType, status, officer, nationality, priority, severity, dateFrom, dateTo
    } = req.query;

    const parsedPage = Math.max(parseInt(page, 10), 1);
    // The search service applies the environment-configured upper bound.
    const parsedPageSize = Math.max(parseInt(pageSize, 10) || 20, 1);
    const resolvedBranchId = resolveSearchBranch(scope, branchId);
    if (resolvedBranchId === "all" && !(req.auth?.permissions || []).includes("search.branch.all")) {
      return sendError(res, 403, "Branch-wide search requires search.branch.all permission.", requestId);
    }

    const { results, meta } = await SearchEngineService.globalSearch({
      tenantId,
      query: q,
      entityType,
      branchId: resolvedBranchId,
      permissions: req.auth?.permissions || [],
      filters: { country, embassy, visaType, status, officer, nationality, priority, severity, dateFrom, dateTo },
      page: parsedPage,
      pageSize: parsedPageSize,
      sort,
      order
    });

    SearchEngineService.recordSearch({ tenantId, userId, query: q, filters: { country, embassy, visaType, status, officer, nationality, priority, severity, dateFrom, dateTo }, resultCount: results.length })
      .catch((error) => console.error("Search history write failed:", error.message));

    return res.status(200).json({
      success: true,
      data: results,
      meta,
      requestId
    });
  } catch (err) {
    console.error("GlobalSearch Error:", err);
    return sendError(res, 500, err.message || "Failed to perform global search.", requestId);
  }
};

/**
 * 2. GET /api/v1/search/suggestions
 * Returns suggested searches, recent searches, and popular queries.
 */
export const GetSearchSuggestions = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);

    if (!scope) {
      return sendError(res, 403, "Tenant context is required.", requestId);
    }

    const suggestions = await SearchEngineService.getSuggestions({ tenantId: scope.tenantId, userId: req.auth?.userId || req.auth?.id, branchId: resolveSearchBranch(scope, req.query.branchId), permissions: req.auth?.permissions || [] });

    return sendSuccess(res, 200, "Search suggestions retrieved successfully.", suggestions, requestId);
  } catch (err) {
    console.error("GetSearchSuggestions Error:", err);
    return sendError(res, 500, err.message || "Failed to fetch search suggestions.", requestId);
  }
};

/**
 * 3. POST /api/v1/search/saved
 * Creates a saved search configuration.
 */
export const SaveSearchQuery = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    const userId = req.auth?.userId || req.auth?.id;
    const { queryName, queryParams, visibility, isPinned } = req.body;

    if (!scope) {
      return sendError(res, 403, "Tenant context is required.", requestId);
    }
    const tenantId = scope.tenantId;

    if (!queryName || !queryParams) {
      return sendError(res, 400, "queryName and queryParams are required.", requestId);
    }

    const savedSearch = await SearchEngineService.saveSearch({
      tenantId,
      userId,
      queryName,
      queryParams,
      visibility,
      isPinned
    });

    publishEvent("SavedSearchCreated", { tenantId, userId, savedSearchId: savedSearch.id });

    return sendSuccess(res, 201, "Search query saved successfully.", savedSearch, requestId);
  } catch (err) {
    console.error("SaveSearchQuery Error:", err);
    return sendError(res, 500, err.message || "Failed to save search query.", requestId);
  }
};

export const ListSavedSearches = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    const userId = req.auth?.userId || req.auth?.id;
    if (!scope || !userId) return sendError(res, 403, "Tenant and user context are required.", requestId);
    const searches = await SearchEngineService.listSavedSearches({ tenantId: scope.tenantId, userId });
    return sendSuccess(res, 200, "Saved searches retrieved successfully.", searches, requestId);
  } catch (err) { return sendError(res, 500, err.message || "Failed to fetch saved searches.", requestId); }
};

export const DeleteSavedSearch = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    const userId = req.auth?.userId || req.auth?.id;
    if (!scope || !userId) return sendError(res, 403, "Tenant and user context are required.", requestId);
    const saved = await SearchEngineService.deleteSavedSearch({ tenantId: scope.tenantId, userId, savedSearchId: req.params.savedSearchId });
    if (!saved) return sendError(res, 404, "Saved search not found.", requestId);
    return sendSuccess(res, 200, "Saved search deleted successfully.", null, requestId);
  } catch (err) { return sendError(res, 500, err.message || "Failed to delete saved search.", requestId); }
};

/**
 * 6. POST /api/v1/search/rebuild
 * Full asynchronous reindex for a tenant. Admin-gated — this is an
 * operational/maintenance capability ("Background Workers" / domain event
 * "SearchRebuilt"), not a regular user-facing search endpoint.
 */
export const RebuildSearchIndex = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    const permissions = req.auth?.permissions || [];

    if (!scope) {
      return sendError(res, 403, "Tenant context is required.", requestId);
    }
    if (!permissions.includes("search.rebuild") && !permissions.includes("admin")) {
      return sendError(res, 403, "Permission denied.", requestId);
    }

    const result = await SearchEngineService.rebuildIndexForTenant({ tenantId: scope.tenantId, branchId: scope.branchId || req.body?.branchId || req.query.branchId || null });
    return sendSuccess(res, 200, "Search index rebuild completed.", result, requestId);
  } catch (err) {
    console.error("RebuildSearchIndex Error:", err);
    return sendError(res, 500, err.message || "Failed to rebuild search index.", requestId);
  }
};
