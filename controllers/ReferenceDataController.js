import ReferenceDataService from "../services/ReferenceDataService.js";
import { sendError, sendSuccess } from "../utils/apiResponse.js";
import { createRequestId } from "../utils/authTokens.js";

const REFERENCE_READ_PERMISSION = "reference.read";

const hasPermission = (permissions = []) => permissions.includes(REFERENCE_READ_PERMISSION) || permissions.includes("admin");

const parsePagination = (query) => ({
  page: Math.max(1, Number.parseInt(query.page, 10) || 1),
  limit: Math.max(1, Math.min(200, Number.parseInt(query.limit, 10) || 50))
});

/**
 * EXT-013 §7-13. Serves reference data from the locally synchronized master
 * tables (§18 "Never call Amadeus for every request") — never a live
 * passthrough call.
 */
export const GetReferenceAirports = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    if (!hasPermission(req.auth?.permissions || [])) return sendError(res, 403, "Permission denied.", requestId);
    const { code, city, country } = req.query;
    const { page, limit } = parsePagination(req.query);
    const result = await ReferenceDataService.getAirports({ code, city, country, page, limit });
    return sendSuccess(res, 200, "Airports retrieved successfully.", { items: result.items, total: result.total, page, limit }, requestId);
  } catch (err) {
    console.error("GetReferenceAirports Error:", err);
    return sendError(res, 500, "Reference data is temporarily unavailable. Please try again.", requestId);
  }
};

export const GetReferenceAirlines = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    if (!hasPermission(req.auth?.permissions || [])) return sendError(res, 403, "Permission denied.", requestId);
    const { code } = req.query;
    const { page, limit } = parsePagination(req.query);
    const result = await ReferenceDataService.getAirlines({ code, page, limit });
    return sendSuccess(res, 200, "Airlines retrieved successfully.", { items: result.items, total: result.total, page, limit }, requestId);
  } catch (err) {
    console.error("GetReferenceAirlines Error:", err);
    return sendError(res, 500, "Reference data is temporarily unavailable. Please try again.", requestId);
  }
};

export const GetReferenceAircraft = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    if (!hasPermission(req.auth?.permissions || [])) return sendError(res, 403, "Permission denied.", requestId);
    const { code } = req.query;
    const { page, limit } = parsePagination(req.query);
    const result = await ReferenceDataService.getAircraft({ code, page, limit });
    return sendSuccess(res, 200, "Aircraft types retrieved successfully.", { items: result.items, total: result.total, page, limit }, requestId);
  } catch (err) {
    console.error("GetReferenceAircraft Error:", err);
    return sendError(res, 500, "Reference data is temporarily unavailable. Please try again.", requestId);
  }
};

export const GetReferenceCountries = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    if (!hasPermission(req.auth?.permissions || [])) return sendError(res, 403, "Permission denied.", requestId);
    const { code } = req.query;
    const { page, limit } = parsePagination(req.query);
    const result = await ReferenceDataService.getCountries({ code, page, limit });
    return sendSuccess(res, 200, "Countries retrieved successfully.", { items: result.items, total: result.total, page, limit }, requestId);
  } catch (err) {
    console.error("GetReferenceCountries Error:", err);
    return sendError(res, 500, "Reference data is temporarily unavailable. Please try again.", requestId);
  }
};

export const GetReferenceCities = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    if (!hasPermission(req.auth?.permissions || [])) return sendError(res, 403, "Permission denied.", requestId);
    const { code, country } = req.query;
    const { page, limit } = parsePagination(req.query);
    const result = await ReferenceDataService.getCities({ code, country, page, limit });
    return sendSuccess(res, 200, "Cities retrieved successfully.", { items: result.items, total: result.total, page, limit }, requestId);
  } catch (err) {
    console.error("GetReferenceCities Error:", err);
    return sendError(res, 500, "Reference data is temporarily unavailable. Please try again.", requestId);
  }
};

/**
 * EXT-014 §5-13. GET /api/v1/reference/airports/search — ranked airport/
 * city autocomplete, always served from EXT-013's local master table +
 * this endpoint's own 1-hour cache (§17 "Never Query Amadeus").
 */
export const SearchReferenceAirports = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const tenantId = req.auth?.tenantId;
    const userId = req.auth?.userId || req.auth?.id;
    if (!tenantId) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req.auth?.permissions || [])) return sendError(res, 403, "Permission denied.", requestId);

    const { q, limit, country, city, internationalOnly, activeOnly } = req.query;
    const result = await ReferenceDataService.searchAirports({ tenantId, userId, q, limit, country, city, internationalOnly, activeOnly, requestId });
    return sendSuccess(res, 200, "Airport suggestions retrieved successfully.", result.results, requestId);
  } catch (err) {
    console.error("SearchReferenceAirports Error:", err);
    const statusCode = err.status || 500;
    const code = err.code || "SEARCH_UNAVAILABLE";
    return sendError(res, statusCode, err.status ? err.message : "Airport search is temporarily unavailable. Please try again.", requestId, { code });
  }
};

/**
 * EXT-014 §20 "AirportSuggestionSelected" — logs which suggested airport a
 * user actually picked, for future ranking tuning.
 */
export const SelectReferenceAirportSuggestion = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const tenantId = req.auth?.tenantId;
    const userId = req.auth?.userId || req.auth?.id;
    if (!tenantId) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req.auth?.permissions || [])) return sendError(res, 403, "Permission denied.", requestId);

    const { query, selectedIata } = req.body;
    const result = await ReferenceDataService.recordSuggestionSelected({ tenantId, userId, query, selectedIata, requestId });
    return sendSuccess(res, 200, "Selection recorded.", result, requestId);
  } catch (err) {
    console.error("SelectReferenceAirportSuggestion Error:", err);
    const statusCode = err.status || 500;
    const code = err.code || "SELECTION_LOG_FAILED";
    return sendError(res, statusCode, err.status ? err.message : "Unable to record selection. Please try again.", requestId, { code });
  }
};
