import TreasuryService from "../services/TreasuryService.js";
import { sendError, sendSuccess } from "../utils/apiResponse.js";
import { getAccessScope } from "../utils/accessScope.js";
import { createRequestId } from "../utils/authTokens.js";

/**
 * Enterprise Treasury Management Controller — Part 18 (TMS).
 * Handles cash position, liquidity forecasting, bank sync, investments,
 * debt administration, FX exposure, and continuous treasury risk management.
 * Tenant-scoped only — no branchId per Master Architecture rules.
 */

const getScope = (req) => {
  const accessScope = getAccessScope(req);
  return {
    tenantId: accessScope?.tenantId || null,
    userId: req.auth?.userId || req.auth?.id || null
  };
};

const hasPermission = (req, ...keys) => {
  const permissions = req.auth?.permissions || [];
  return permissions.includes("admin") || keys.some((key) => permissions.includes(key));
};

const statusFromError = (err) => {
  const msg = err.message || "";
  if (/not found/i.test(msg)) return 404;
  if (/required|invalid|missing/i.test(msg)) return 400;
  return 500;
};

// 1. Cash Position
export const calculateCashPosition = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const { tenantId, userId } = getScope(req);
    if (!tenantId) return sendError(res, 403, "Tenant context required.", requestId);
    if (!hasPermission(req, "finance.treasury.manage")) return sendError(res, 403, "Permission denied.", requestId);

    const { valuationDate } = req.body || {};
    const result = await TreasuryService.calculateCashPosition({
      tenantId,
      valuationDate,
      userId
    });

    return sendSuccess(res, 201, "Cash position calculated successfully.", result, requestId);
  } catch (err) {
    return sendError(res, statusFromError(err), err.message, requestId);
  }
};

export const getCashPosition = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const { tenantId } = getScope(req);
    if (!tenantId) return sendError(res, 403, "Tenant context required.", requestId);
    if (!hasPermission(req, "finance.treasury.read", "finance.treasury.manage")) return sendError(res, 403, "Permission denied.", requestId);

    const result = await TreasuryService.getLatestCashPosition({ tenantId });

    return sendSuccess(res, 200, "Cash position retrieved successfully.", result, requestId);
  } catch (err) {
    return sendError(res, statusFromError(err), err.message, requestId);
  }
};

// 2. Treasury Dashboard
export const getTreasuryDashboard = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const { tenantId } = getScope(req);
    if (!tenantId) return sendError(res, 403, "Tenant context required.", requestId);
    if (!hasPermission(req, "finance.treasury.read", "finance.treasury.manage")) return sendError(res, 403, "Permission denied.", requestId);

    const dashboard = await TreasuryService.getTreasuryDashboard({ tenantId });

    return sendSuccess(res, 200, "Treasury dashboard retrieved successfully.", dashboard, requestId);
  } catch (err) {
    return sendError(res, statusFromError(err), err.message, requestId);
  }
};

// 3. Bank Sync
export const syncBankBalances = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const { tenantId, userId } = getScope(req);
    if (!tenantId) return sendError(res, 403, "Tenant context required.", requestId);
    if (!hasPermission(req, "finance.treasury.manage")) return sendError(res, 403, "Permission denied.", requestId);

    const { bankAccountId, balanceOverrides } = req.body || {};
    const result = await TreasuryService.syncBankBalances({
      tenantId,
      bankAccountId,
      balanceOverrides,
      userId
    });

    return sendSuccess(res, 200, "Bank balances synchronized successfully.", result, requestId);
  } catch (err) {
    return sendError(res, statusFromError(err), err.message, requestId);
  }
};

// 4. Liquidity Forecast
export const generateLiquidityForecast = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const { tenantId, userId } = getScope(req);
    if (!tenantId) return sendError(res, 403, "Tenant context required.", requestId);
    if (!hasPermission(req, "finance.treasury.manage")) return sendError(res, 403, "Permission denied.", requestId);

    const { horizon, baseCurrency, minimumBuffer, notes } = req.body || {};
    const forecast = await TreasuryService.generateLiquidityForecast({
      tenantId,
      horizon,
      baseCurrency,
      minimumBuffer,
      notes,
      userId
    });

    return sendSuccess(res, 201, "Liquidity forecast generated successfully.", forecast, requestId);
  } catch (err) {
    return sendError(res, statusFromError(err), err.message, requestId);
  }
};

export const listLiquidityForecasts = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const { tenantId } = getScope(req);
    if (!tenantId) return sendError(res, 403, "Tenant context required.", requestId);
    if (!hasPermission(req, "finance.treasury.read", "finance.treasury.manage")) return sendError(res, 403, "Permission denied.", requestId);

    const { status, page, limit } = req.query;
    const result = await TreasuryService.listLiquidityForecasts({
      tenantId,
      status,
      page,
      limit
    });

    return sendSuccess(res, 200, "Liquidity forecasts retrieved successfully.", result, requestId);
  } catch (err) {
    return sendError(res, statusFromError(err), err.message, requestId);
  }
};

// 5. Investment Management
export const createInvestment = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const { tenantId, userId } = getScope(req);
    if (!tenantId) return sendError(res, 403, "Tenant context required.", requestId);
    if (!hasPermission(req, "finance.treasury.manage")) return sendError(res, 403, "Permission denied.", requestId);

    const investment = await TreasuryService.createInvestment({
      tenantId,
      ...req.body,
      userId
    });

    return sendSuccess(res, 201, "Treasury investment created successfully.", investment, requestId);
  } catch (err) {
    return sendError(res, statusFromError(err), err.message, requestId);
  }
};

export const listInvestments = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const { tenantId } = getScope(req);
    if (!tenantId) return sendError(res, 403, "Tenant context required.", requestId);
    if (!hasPermission(req, "finance.treasury.read", "finance.treasury.manage")) return sendError(res, 403, "Permission denied.", requestId);

    const { status, investmentType, page, limit } = req.query;
    const result = await TreasuryService.listInvestments({
      tenantId,
      status,
      investmentType,
      page,
      limit
    });

    return sendSuccess(res, 200, "Treasury investments retrieved successfully.", result, requestId);
  } catch (err) {
    return sendError(res, statusFromError(err), err.message, requestId);
  }
};

export const getInvestmentById = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const { tenantId } = getScope(req);
    if (!tenantId) return sendError(res, 403, "Tenant context required.", requestId);
    if (!hasPermission(req, "finance.treasury.read", "finance.treasury.manage")) return sendError(res, 403, "Permission denied.", requestId);

    const investment = await TreasuryService.getInvestmentById({
      tenantId,
      investmentId: req.params.investmentId
    });

    return sendSuccess(res, 200, "Investment retrieved successfully.", investment, requestId);
  } catch (err) {
    return sendError(res, statusFromError(err), err.message, requestId);
  }
};

export const updateInvestmentStatus = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const { tenantId, userId } = getScope(req);
    if (!tenantId) return sendError(res, 403, "Tenant context required.", requestId);
    if (!hasPermission(req, "finance.treasury.manage")) return sendError(res, 403, "Permission denied.", requestId);

    const investment = await TreasuryService.updateInvestmentStatus({
      tenantId,
      investmentId: req.params.investmentId,
      status: req.body.status,
      notes: req.body.notes,
      userId
    });

    return sendSuccess(res, 200, "Investment status updated successfully.", investment, requestId);
  } catch (err) {
    return sendError(res, statusFromError(err), err.message, requestId);
  }
};

// 6. Debt Management
export const recordDebt = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const { tenantId, userId } = getScope(req);
    if (!tenantId) return sendError(res, 403, "Tenant context required.", requestId);
    if (!hasPermission(req, "finance.treasury.manage")) return sendError(res, 403, "Permission denied.", requestId);

    const debt = await TreasuryService.recordDebt({
      tenantId,
      ...req.body,
      userId
    });

    return sendSuccess(res, 201, "Treasury debt facility recorded successfully.", debt, requestId);
  } catch (err) {
    return sendError(res, statusFromError(err), err.message, requestId);
  }
};

export const listDebts = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const { tenantId } = getScope(req);
    if (!tenantId) return sendError(res, 403, "Tenant context required.", requestId);
    if (!hasPermission(req, "finance.treasury.read", "finance.treasury.manage")) return sendError(res, 403, "Permission denied.", requestId);

    const { status, debtType, page, limit } = req.query;
    const result = await TreasuryService.listDebts({
      tenantId,
      status,
      debtType,
      page,
      limit
    });

    return sendSuccess(res, 200, "Treasury debts retrieved successfully.", result, requestId);
  } catch (err) {
    return sendError(res, statusFromError(err), err.message, requestId);
  }
};

export const getDebtById = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const { tenantId } = getScope(req);
    if (!tenantId) return sendError(res, 403, "Tenant context required.", requestId);
    if (!hasPermission(req, "finance.treasury.read", "finance.treasury.manage")) return sendError(res, 403, "Permission denied.", requestId);

    const debt = await TreasuryService.getDebtById({
      tenantId,
      debtId: req.params.debtId
    });

    return sendSuccess(res, 200, "Debt facility retrieved successfully.", debt, requestId);
  } catch (err) {
    return sendError(res, statusFromError(err), err.message, requestId);
  }
};

export const updateDebtStatus = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const { tenantId, userId } = getScope(req);
    if (!tenantId) return sendError(res, 403, "Tenant context required.", requestId);
    if (!hasPermission(req, "finance.treasury.manage")) return sendError(res, 403, "Permission denied.", requestId);

    const debt = await TreasuryService.updateDebtStatus({
      tenantId,
      debtId: req.params.debtId,
      status: req.body.status,
      outstandingBalance: req.body.outstandingBalance,
      notes: req.body.notes,
      userId
    });

    return sendSuccess(res, 200, "Debt status updated successfully.", debt, requestId);
  } catch (err) {
    return sendError(res, statusFromError(err), err.message, requestId);
  }
};

// 7. FX Exposure
export const calculateFXExposure = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const { tenantId, userId } = getScope(req);
    if (!tenantId) return sendError(res, 403, "Tenant context required.", requestId);
    if (!hasPermission(req, "finance.treasury.manage")) return sendError(res, 403, "Permission denied.", requestId);

    const { baseCurrency } = req.body || {};
    const exposures = await TreasuryService.calculateFXExposure({
      tenantId,
      baseCurrency,
      userId
    });

    return sendSuccess(res, 200, "FX exposure calculated successfully.", exposures, requestId);
  } catch (err) {
    return sendError(res, statusFromError(err), err.message, requestId);
  }
};

export const getFXExposures = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const { tenantId } = getScope(req);
    if (!tenantId) return sendError(res, 403, "Tenant context required.", requestId);
    if (!hasPermission(req, "finance.treasury.read", "finance.treasury.manage")) return sendError(res, 403, "Permission denied.", requestId);

    const exposures = await TreasuryService.getFXExposures({ tenantId });
    return sendSuccess(res, 200, "FX exposures retrieved successfully.", exposures, requestId);
  } catch (err) {
    return sendError(res, statusFromError(err), err.message, requestId);
  }
};

// 8. Treasury Risk Controls
export const evaluateTreasuryRisks = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const { tenantId, userId } = getScope(req);
    if (!tenantId) return sendError(res, 403, "Tenant context required.", requestId);
    if (!hasPermission(req, "finance.treasury.manage")) return sendError(res, 403, "Permission denied.", requestId);

    const risks = await TreasuryService.evaluateTreasuryRisks({
      tenantId,
      userId
    });

    return sendSuccess(res, 200, "Treasury risks evaluated successfully.", risks, requestId);
  } catch (err) {
    return sendError(res, statusFromError(err), err.message, requestId);
  }
};

export const getTreasuryRisks = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const { tenantId } = getScope(req);
    if (!tenantId) return sendError(res, 403, "Tenant context required.", requestId);
    if (!hasPermission(req, "finance.treasury.read", "finance.treasury.manage")) return sendError(res, 403, "Permission denied.", requestId);

    const { status, riskType } = req.query;
    const risks = await TreasuryService.getTreasuryRisks({ tenantId, status, riskType });

    return sendSuccess(res, 200, "Treasury risk assessments retrieved successfully.", risks, requestId);
  } catch (err) {
    return sendError(res, statusFromError(err), err.message, requestId);
  }
};
