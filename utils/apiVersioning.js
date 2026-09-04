import ApiVersionRegistryModel from "../models/ApiVersionRegistryModel.js";
import CacheManager from "./cacheManager.js";
import { AppError } from "./errorContract.js";
import { getApiVersionConfig } from "./apiVersionConfig.js";

/**
 * Enterprise API Version Strategy Standard (Enterprise Architecture
 * Hardening Phase, Improvement 8). URL versioning (`/api/v1/...`) is
 * already this codebase's real strategy — every route is already mounted
 * this way. This file is the missing lifecycle layer on top of that
 * already-real strategy: a registry, deprecation headers, and a
 * published support-window policy.
 */

const addMonths = (date, months) => {
  const result = new Date(date);
  result.setMonth(result.getMonth() + months);
  return result;
};

const cacheKey = (apiName, version) => `api-version-registry:${apiName}:${version}`;

/** Real duplicate-definition prevention — the same shape/reasoning as Improvement 7's `registerEvent`. Same owner/status re-registration is a safe idempotent no-op; a different owner is a genuine governance conflict. */
export const registerApiVersion = async (apiName, version, { status = "GA", owner, description = null, supportedUntil = null, userId = null }) => {
  const config = getApiVersionConfig();
  if (!apiName || !version) throw new Error("apiName and version are required.");
  if (!config.lifecycleStatuses.includes(status)) throw new Error(`Invalid status "${status}".`);
  if (!owner) throw new Error("owner is required.");

  const existing = await ApiVersionRegistryModel.findOne({ apiName, version });
  if (existing) {
    if (existing.owner !== owner) {
      throw new AppError("API_VERSION_REGISTRY_CONFLICT", { details: { apiName, version, registeredOwner: existing.owner } });
    }
    return existing.toJSON();
  }

  const resolvedSupportedUntil = supportedUntil || (status === "GA" ? addMonths(new Date(), config.gaSupportMonths) : null);
  const created = await ApiVersionRegistryModel.create({
    apiName, version, status, owner, description, supportedUntil: resolvedSupportedUntil,
    createdBy: userId || null, updatedBy: userId || null
  });
  await CacheManager.invalidate(cacheKey(apiName, version));
  return created.toJSON();
};

export const deprecateApiVersion = async (apiName, version, { sunsetAt = null, latestVersion = null, reason = null, userId = null } = {}) => {
  const config = getApiVersionConfig();
  const entry = await ApiVersionRegistryModel.findOne({ apiName, version });
  if (!entry) throw new Error("API version registry entry not found.");
  if (["Sunset", "Retired"].includes(entry.status)) throw new Error(`Cannot deprecate an API version that is already ${entry.status}.`);

  entry.status = "Deprecated";
  entry.deprecatedAt = new Date();
  entry.deprecationReason = reason;
  entry.latestVersion = latestVersion;
  entry.sunsetAt = sunsetAt ? new Date(sunsetAt) : addMonths(new Date(), config.deprecatedSupportMonths);
  entry.supportedUntil = entry.sunsetAt;
  entry.updatedBy = userId || null;
  await entry.save();
  await CacheManager.invalidate(cacheKey(apiName, version));
  return entry.toJSON();
};

/** The real point where a Deprecated version's support window formally ends — from here, `middleware/apiVersionLifecycle.js` rejects every request against it. */
export const sunsetApiVersion = async (apiName, version, userId = null) => {
  const entry = await ApiVersionRegistryModel.findOne({ apiName, version });
  if (!entry) throw new Error("API version registry entry not found.");
  if (entry.status === "Retired") throw new Error("Cannot sunset a Retired API version.");
  entry.status = "Sunset";
  entry.sunsetAt = entry.sunsetAt || new Date();
  entry.updatedBy = userId || null;
  await entry.save();
  await CacheManager.invalidate(cacheKey(apiName, version));
  return entry.toJSON();
};

export const retireApiVersion = async (apiName, version, userId = null) => {
  const entry = await ApiVersionRegistryModel.findOne({ apiName, version });
  if (!entry) throw new Error("API version registry entry not found.");
  entry.status = "Retired";
  entry.retiredAt = new Date();
  entry.updatedBy = userId || null;
  await entry.save();
  await CacheManager.invalidate(cacheKey(apiName, version));
  return entry.toJSON();
};

/** Cached lookup — the real hot-path call `middleware/apiVersionLifecycle.js` makes on every request against a registered API. `null` (unregistered) is a real, valid answer, never fabricated as GA. */
export const getApiVersionStatus = async (apiName, version) => {
  const config = getApiVersionConfig();
  const { data } = await CacheManager.getOrCompute(
    cacheKey(apiName, version),
    async () => (await ApiVersionRegistryModel.findOne({ apiName, version }).lean()) || null,
    config.cacheTtlSeconds
  );
  return data;
};

export const listApiVersions = async (query = {}) => {
  const config = getApiVersionConfig();
  const filter = {};
  if (query.apiName) filter.apiName = query.apiName;
  if (query.status) filter.status = query.status;
  if (query.owner) filter.owner = query.owner;
  const page = Math.max(parseInt(query.page, 10) || 1, 1);
  const pageSize = Math.min(Math.max(parseInt(query.pageSize, 10) || config.defaultPageSize, 1), config.maxPageSize);

  const [items, total] = await Promise.all([
    ApiVersionRegistryModel.find(filter).sort({ apiName: 1, version: 1 }).skip((page - 1) * pageSize).limit(pageSize).lean(),
    ApiVersionRegistryModel.countDocuments(filter)
  ]);
  return { items, pagination: { total, page, pageSize, totalPages: Math.ceil(total / pageSize) } };
};

export const getApiVersionEntry = async (apiName, version) => {
  const entry = await ApiVersionRegistryModel.findOne({ apiName, version }).lean();
  if (!entry) throw new Error("API version registry entry not found.");
  return entry;
};
