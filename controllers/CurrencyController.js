import CurrencyService from "../services/CurrencyService.js";
import { sendSuccess, sendError } from "../utils/apiResponse.js";
import { createRequestId } from "../utils/authTokens.js";
import { getAccessScope } from "../utils/accessScope.js";

const hasPermission = (req, ...keys) => {
  const permissions = req.auth?.permissions || [];
  return permissions.includes("admin") || keys.some((key) => permissions.includes(key));
};

const statusFromError = (error) => {
  const message = error.message || "";
  if (message.includes("already exists")) return 409;
  if (message.includes("not found")) return 404;
  if (message.includes("required") || message.includes("cannot") || message.includes("Cannot") || message.includes("Invalid") || message.includes("must") || message.includes("not a recognized") || message.includes("not configured") || message.includes("No exchange rate available") || message.includes("differ")) return 400;
  return 500;
};

// ---- Currencies ----

export const createCurrency = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.currency.manage")) return sendError(res, 403, "Permission denied.", requestId);
    const userId = req.auth?.userId || req.auth?.id || null;

    const currency = await CurrencyService.createCurrency(req.body, scope.tenantId, userId);
    return sendSuccess(res, 201, "Currency created successfully.", currency, requestId);
  } catch (error) {
    console.error("createCurrency error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to create currency.", requestId);
  }
};

export const listCurrencies = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.currency.read", "finance.read")) return sendError(res, 403, "Permission denied.", requestId);

    const items = await CurrencyService.listCurrencies(req.query, scope.tenantId);
    return sendSuccess(res, 200, "Currencies retrieved successfully.", { items }, requestId);
  } catch (error) {
    console.error("listCurrencies error:", error);
    return sendError(res, 500, error.message || "Failed to retrieve currencies.", requestId);
  }
};

export const getCurrency = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.currency.read", "finance.read")) return sendError(res, 403, "Permission denied.", requestId);

    const currency = await CurrencyService.getCurrencyById(req.params.currencyId, scope.tenantId);
    return sendSuccess(res, 200, "Currency retrieved successfully.", currency, requestId);
  } catch (error) {
    console.error("getCurrency error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to retrieve currency.", requestId);
  }
};

export const activateCurrency = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.currency.manage")) return sendError(res, 403, "Permission denied.", requestId);
    const userId = req.auth?.userId || req.auth?.id || null;

    const currency = await CurrencyService.activateCurrency(req.params.currencyId, scope.tenantId, userId);
    return sendSuccess(res, 200, "Currency activated successfully.", currency, requestId);
  } catch (error) {
    console.error("activateCurrency error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to activate currency.", requestId);
  }
};

export const suspendCurrency = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.currency.manage")) return sendError(res, 403, "Permission denied.", requestId);
    const userId = req.auth?.userId || req.auth?.id || null;

    const currency = await CurrencyService.suspendCurrency(req.params.currencyId, req.body, scope.tenantId, userId);
    return sendSuccess(res, 200, "Currency suspended successfully.", currency, requestId);
  } catch (error) {
    console.error("suspendCurrency error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to suspend currency.", requestId);
  }
};

export const archiveCurrency = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.currency.manage")) return sendError(res, 403, "Permission denied.", requestId);
    const userId = req.auth?.userId || req.auth?.id || null;

    const currency = await CurrencyService.archiveCurrency(req.params.currencyId, scope.tenantId, userId);
    return sendSuccess(res, 200, "Currency archived successfully.", currency, requestId);
  } catch (error) {
    console.error("archiveCurrency error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to archive currency.", requestId);
  }
};

// ---- Exchange Rates ----

export const createExchangeRate = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.currency.manage")) return sendError(res, 403, "Permission denied.", requestId);
    const userId = req.auth?.userId || req.auth?.id || null;

    const exchangeRate = await CurrencyService.createExchangeRate(req.body, scope.tenantId, userId);
    return sendSuccess(res, 201, "Exchange rate recorded successfully.", exchangeRate, requestId);
  } catch (error) {
    console.error("createExchangeRate error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to record exchange rate.", requestId);
  }
};

export const listExchangeRates = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.currency.read", "finance.read")) return sendError(res, 403, "Permission denied.", requestId);

    const result = await CurrencyService.listExchangeRates(req.query, scope.tenantId);
    return sendSuccess(res, 200, "Exchange rates retrieved successfully.", result, requestId);
  } catch (error) {
    console.error("listExchangeRates error:", error);
    return sendError(res, 500, error.message || "Failed to retrieve exchange rates.", requestId);
  }
};

export const importExchangeRates = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.currency.manage")) return sendError(res, 403, "Permission denied.", requestId);
    const userId = req.auth?.userId || req.auth?.id || null;

    const result = await CurrencyService.importRatesFromProvider(scope.tenantId, userId, req.body);
    return sendSuccess(res, 201, "Exchange rates imported successfully.", result, requestId);
  } catch (error) {
    console.error("importExchangeRates error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to import exchange rates.", requestId);
  }
};

// ---- Conversion ----

export const convertCurrency = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.currency.read", "finance.read")) return sendError(res, 403, "Permission denied.", requestId);

    const { amount, fromCurrency, toCurrency, asOfDate, rateType } = req.query;
    if (!amount || !fromCurrency || !toCurrency) return sendError(res, 400, "amount, fromCurrency, and toCurrency are required.", requestId);

    const result = await CurrencyService.convert(Number(amount), fromCurrency, toCurrency, scope.tenantId, { asOfDate, rateType });
    return sendSuccess(res, 200, "Currency converted successfully.", result, requestId);
  } catch (error) {
    console.error("convertCurrency error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to convert currency.", requestId);
  }
};

// ---- Revaluation ----

export const runRevaluation = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.currency.manage")) return sendError(res, 403, "Permission denied.", requestId);
    const userId = req.auth?.userId || req.auth?.id || null;

    const result = await CurrencyService.runPeriodEndRevaluation(scope.tenantId, userId, req.body?.revaluationDate ? new Date(req.body.revaluationDate) : undefined);
    return sendSuccess(res, 200, "Revaluation run completed.", result, requestId);
  } catch (error) {
    console.error("runRevaluation error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to run revaluation.", requestId);
  }
};

export const listRevaluations = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.currency.read", "finance.read")) return sendError(res, 403, "Permission denied.", requestId);

    const items = await CurrencyService.listRevaluations(req.query, scope.tenantId);
    return sendSuccess(res, 200, "Revaluations retrieved successfully.", { items }, requestId);
  } catch (error) {
    console.error("listRevaluations error:", error);
    return sendError(res, 500, error.message || "Failed to retrieve revaluations.", requestId);
  }
};

// ---- Reporting ----

export const getCurrencyExposure = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.currency.read", "finance.read")) return sendError(res, 403, "Permission denied.", requestId);

    const result = await CurrencyService.getCurrencyExposure(scope.tenantId);
    return sendSuccess(res, 200, "Currency exposure retrieved successfully.", result, requestId);
  } catch (error) {
    console.error("getCurrencyExposure error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to retrieve currency exposure.", requestId);
  }
};
