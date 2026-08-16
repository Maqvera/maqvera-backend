import EnterprisePlanningService from "../services/EnterprisePlanningService.js";
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
  if (message.includes("required") || message.includes("cannot") || message.includes("Cannot") || message.includes("Invalid") || message.includes("Only") || message.includes("Published budgets cannot")) return 400;
  return 500;
};

// --- BUDGET ENDPOINTS ---

export const createBudget = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.planning.manage", "finance.budget.create")) return sendError(res, 403, "Permission denied.", requestId);
    const userId = req.auth?.userId || req.auth?.id || "Finance Admin";

    const budget = await EnterprisePlanningService.createBudget(scope.tenantId, req.body, userId);
    return sendSuccess(res, 201, "Enterprise budget created successfully.", budget, requestId);
  } catch (error) {
    console.error("createBudget error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to create budget.", requestId);
  }
};

export const listBudgets = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.planning.read", "finance.budget.read")) return sendError(res, 403, "Permission denied.", requestId);

    const result = await EnterprisePlanningService.listBudgets(scope.tenantId, req.query);
    return sendSuccess(res, 200, "Enterprise budgets retrieved successfully.", result, requestId);
  } catch (error) {
    console.error("listBudgets error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to list budgets.", requestId);
  }
};

export const getBudget = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.planning.read", "finance.budget.read")) return sendError(res, 403, "Permission denied.", requestId);

    const budget = await EnterprisePlanningService.getBudgetById(scope.tenantId, req.params.budgetId);
    return sendSuccess(res, 200, "Enterprise budget retrieved successfully.", budget, requestId);
  } catch (error) {
    console.error("getBudget error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to get budget.", requestId);
  }
};

export const updateBudget = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.planning.manage", "finance.budget.update")) return sendError(res, 403, "Permission denied.", requestId);
    const userId = req.auth?.userId || req.auth?.id || "Finance Admin";

    const budget = await EnterprisePlanningService.updateBudget(scope.tenantId, req.params.budgetId, req.body, userId);
    return sendSuccess(res, 200, "Enterprise budget updated successfully.", budget, requestId);
  } catch (error) {
    console.error("updateBudget error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to update budget.", requestId);
  }
};

export const submitBudget = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.planning.manage", "finance.budget.submit")) return sendError(res, 403, "Permission denied.", requestId);
    const userId = req.auth?.userId || req.auth?.id || "Finance Admin";

    const budget = await EnterprisePlanningService.submitBudget(scope.tenantId, req.params.budgetId, userId);
    return sendSuccess(res, 200, "Budget submitted for approval.", budget, requestId);
  } catch (error) {
    console.error("submitBudget error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to submit budget.", requestId);
  }
};

export const approveBudget = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.planning.manage", "finance.budget.approve")) return sendError(res, 403, "Permission denied.", requestId);
    const userId = req.auth?.userId || req.auth?.id || "Finance Approver";

    const { decision = "Approved", comments } = req.body;
    const budget = await EnterprisePlanningService.approveBudget(scope.tenantId, req.params.budgetId, decision, comments, userId);
    return sendSuccess(res, 200, `Budget decision '${decision}' recorded.`, budget, requestId);
  } catch (error) {
    console.error("approveBudget error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to process budget approval.", requestId);
  }
};

export const publishBudget = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.planning.manage", "finance.budget.publish")) return sendError(res, 403, "Permission denied.", requestId);
    const userId = req.auth?.userId || req.auth?.id || "Finance Admin";

    const budget = await EnterprisePlanningService.publishBudget(scope.tenantId, req.params.budgetId, userId);
    return sendSuccess(res, 200, "Budget published successfully.", budget, requestId);
  } catch (error) {
    console.error("publishBudget error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to publish budget.", requestId);
  }
};

export const createBudgetRevision = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.planning.manage", "finance.budget.update")) return sendError(res, 403, "Permission denied.", requestId);
    const userId = req.auth?.userId || req.auth?.id || "Finance Admin";

    const newRevision = await EnterprisePlanningService.createBudgetRevision(scope.tenantId, req.params.budgetId, req.body, userId);
    return sendSuccess(res, 201, "New budget revision created successfully.", newRevision, requestId);
  } catch (error) {
    console.error("createBudgetRevision error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to create budget revision.", requestId);
  }
};

export const getBudgetRevisions = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.planning.read", "finance.budget.read")) return sendError(res, 403, "Permission denied.", requestId);

    const revisions = await EnterprisePlanningService.getBudgetRevisions(scope.tenantId, req.params.budgetId);
    return sendSuccess(res, 200, "Budget revisions history retrieved.", revisions, requestId);
  } catch (error) {
    console.error("getBudgetRevisions error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to retrieve budget revisions.", requestId);
  }
};

// --- FORECAST ENDPOINTS ---

export const generateForecast = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.planning.manage", "finance.forecast.create")) return sendError(res, 403, "Permission denied.", requestId);
    const userId = req.auth?.userId || req.auth?.id || "Finance Planner";

    const forecast = await EnterprisePlanningService.generateForecast(scope.tenantId, req.body, userId);
    return sendSuccess(res, 201, "Financial forecast generated successfully.", forecast, requestId);
  } catch (error) {
    console.error("generateForecast error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to generate forecast.", requestId);
  }
};

export const listForecasts = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.planning.read", "finance.forecast.read")) return sendError(res, 403, "Permission denied.", requestId);

    const result = await EnterprisePlanningService.listForecasts(scope.tenantId, req.query);
    return sendSuccess(res, 200, "Financial forecasts retrieved successfully.", result, requestId);
  } catch (error) {
    console.error("listForecasts error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to list forecasts.", requestId);
  }
};

export const getForecast = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.planning.read", "finance.forecast.read")) return sendError(res, 403, "Permission denied.", requestId);

    const forecast = await EnterprisePlanningService.getForecastById(scope.tenantId, req.params.forecastId);
    return sendSuccess(res, 200, "Financial forecast retrieved successfully.", forecast, requestId);
  } catch (error) {
    console.error("getForecast error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to get forecast.", requestId);
  }
};

// --- VARIANCE ENDPOINTS ---

export const calculateVariance = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.planning.manage", "finance.variance.calculate")) return sendError(res, 403, "Permission denied.", requestId);
    const userId = req.auth?.userId || req.auth?.id || "Finance Analyst";

    const variance = await EnterprisePlanningService.calculateVariance(scope.tenantId, req.body, userId);
    return sendSuccess(res, 201, "Variance analysis calculated successfully.", variance, requestId);
  } catch (error) {
    console.error("calculateVariance error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to calculate variance.", requestId);
  }
};

export const listVariances = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.planning.read", "finance.variance.read")) return sendError(res, 403, "Permission denied.", requestId);

    const result = await EnterprisePlanningService.listVariances(scope.tenantId, req.query);
    return sendSuccess(res, 200, "Variance analyses retrieved successfully.", result, requestId);
  } catch (error) {
    console.error("listVariances error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to list variances.", requestId);
  }
};

export const getVariance = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.planning.read", "finance.variance.read")) return sendError(res, 403, "Permission denied.", requestId);

    const variance = await EnterprisePlanningService.getVarianceById(scope.tenantId, req.params.varianceId);
    return sendSuccess(res, 200, "Variance analysis retrieved successfully.", variance, requestId);
  } catch (error) {
    console.error("getVariance error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to get variance analysis.", requestId);
  }
};

// --- SCENARIO ENDPOINTS ---

export const createScenario = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.planning.manage", "finance.scenario.create")) return sendError(res, 403, "Permission denied.", requestId);
    const userId = req.auth?.userId || req.auth?.id || "Finance Strategist";

    const scenario = await EnterprisePlanningService.createScenario(scope.tenantId, req.body, userId);
    return sendSuccess(res, 201, "Financial scenario model created successfully.", scenario, requestId);
  } catch (error) {
    console.error("createScenario error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to create scenario model.", requestId);
  }
};

export const listScenarios = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.planning.read", "finance.scenario.read")) return sendError(res, 403, "Permission denied.", requestId);

    const result = await EnterprisePlanningService.listScenarios(scope.tenantId, req.query);
    return sendSuccess(res, 200, "Financial scenarios retrieved successfully.", result, requestId);
  } catch (error) {
    console.error("listScenarios error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to list scenarios.", requestId);
  }
};

export const getScenario = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.planning.read", "finance.scenario.read")) return sendError(res, 403, "Permission denied.", requestId);

    const scenario = await EnterprisePlanningService.getScenarioById(scope.tenantId, req.params.scenarioId);
    return sendSuccess(res, 200, "Financial scenario retrieved successfully.", scenario, requestId);
  } catch (error) {
    console.error("getScenario error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to get scenario.", requestId);
  }
};

export const evaluateScenario = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.planning.manage", "finance.scenario.evaluate")) return sendError(res, 403, "Permission denied.", requestId);
    const userId = req.auth?.userId || req.auth?.id || "Finance Strategist";

    const scenario = await EnterprisePlanningService.evaluateScenario(scope.tenantId, req.params.scenarioId, userId);
    return sendSuccess(res, 200, "Scenario evaluation completed.", scenario, requestId);
  } catch (error) {
    console.error("evaluateScenario error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to evaluate scenario.", requestId);
  }
};

// --- PLANNING DASHBOARD ---

export const getPlanningDashboard = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.planning.read", "finance.dashboard.read")) return sendError(res, 403, "Permission denied.", requestId);

    const dashboard = await EnterprisePlanningService.getPlanningDashboard(scope.tenantId, req.query);
    return sendSuccess(res, 200, "Executive planning dashboard retrieved successfully.", dashboard, requestId);
  } catch (error) {
    console.error("getPlanningDashboard error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to retrieve planning dashboard.", requestId);
  }
};
